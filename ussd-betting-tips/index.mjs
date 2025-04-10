import axios from 'axios';
import * as cheerio from 'cheerio';

// MPesa API credentials
const MPESA_SHORTCODE = '174379';
const MPESA_PASSKEY = 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
const MPESA_CONSUMER_KEY = 'FkyGC14QM6A0yGZF4DVImGUWOEzqKd2pX5Ha3jQsfAsz6Snk';
const MPESA_CONSUMER_SECRET = 'aSw3BmSuHNXvDkUIyRt4BzfqUYS9KiKRp5uooVccQFbtWUpDt3ycHxx4g4oJZz68';
const MPESA_AUTH_URL = 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';
const MPESA_STK_PUSH_URL = 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest';
const CALLBACK_URL = 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest'; // Replace with your actual callback URL

// Configuration constants
const SCRAPE_TIMEOUT = 5000;
const LAMBDA_TIMEOUT = 8000;
const CACHE_TTL = 300000; // 5 minutes

// Response templates
const RESPONSES = {
  mainMenu: `CON Today's Football Tips\n1. Show Top 5 Matches\n2. About Service\n3. Make Payment to View Tips`,
  about: 'CON Betstudy Betting Tips\nOfficial predictions source\n0. Back',
  error: 'END Service error. Try later.',
  timeout: 'END Service timeout. Please try again.',
  invalid: 'END Invalid option.',
  paymentPrompt: 'CON To view the tips, please pay Ksh 5 via MPesa.\nYou will receive a payment prompt shortly.',
  paymentSuccess: 'END Payment successful. You can now view the betting tips.',
  paymentFailure: 'END Payment failed. Please try again later.',
  invalidPhone: 'END Invalid phone number format. Please use your MPesa registered number.'
};

// Cache implementation
const cache = {
  timestamp: 0,
  data: [],
  get isValid() {
    return Date.now() - this.timestamp < CACHE_TTL && this.data.length > 0;
  }
};

// Timeout handler
const timeoutPromise = (timeout) => 
  new Promise((_, reject) => 
    setTimeout(() => reject(new Error('Timeout')), timeout)
  );

export const handler = async (event) => {
  try {
    return await Promise.race([
      mainHandler(event),
      timeoutPromise(LAMBDA_TIMEOUT)
    ]);
  } catch (error) {
    console.error('Handler error:', error.message);
    return errorResponse(error);
  }
};

async function mainHandler(event) {
  const { text = '', phoneNumber = '' } = parseInput(event);
  const lastInput = text.split('*').pop().trim();

  try {
    if (text === '') return textResponse(RESPONSES.mainMenu);
    if (lastInput === '1') return await handlePredictions();
    if (lastInput === '2') return textResponse(RESPONSES.about);
    if (lastInput === '3') return await initiateMpesaPayment(phoneNumber);
    if (lastInput === '0') return textResponse(RESPONSES.mainMenu);
    return textResponse(RESPONSES.invalid);
  } catch (error) {
    console.error('Processing error:', error);
    return textResponse(RESPONSES.error);
  }
}

async function handlePredictions() {
  const tips = await scrapeBetstudyPredictions();
  
  if (tips.length === 0) {
    return textResponse(RESPONSES.error);
  }

  const formattedTips = tips
    .slice(0, 5)
    .map((tip, index) => 
      `${index + 1}. ${tip.match}\nTime: ${tip.time}\nTip: ${tip.tip} (${tip.odds})`
    )
    .join('\n\n');

  return textResponse(`CON Today's Top Matches:\n${formattedTips}\n0. Back`);
}

async function scrapeBetstudyPredictions() {
  if (cache.isValid) return cache.data;

  try {
    const response = await axios.get('https://www.betstudy.com/predictions/', {
      timeout: SCRAPE_TIMEOUT,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    const $ = cheerio.load(response.data);
    const newData = [];

    $('div.computer-predictions-tbl tr').each((i, el) => {
      if (newData.length >= 5) return false;

      const $row = $(el);
      const time = $row.find('.time span').text().replace(/\s+/g, ' ').trim();
      const match = $row.find('.match a').text().split('\n').slice(0, 2).join(' vs ').trim();
      const tip = $row.find('.predictons.hide-sm').text().trim();
      const odds = $row.find('.betnow a').text().match(/(\d+\.\d+)/)?.[1] || 'N/A';

      if (match && time) {
        newData.push({ time, match, tip, odds });
      }
    });

    cache.data = newData;
    cache.timestamp = Date.now();
    return newData;
  } catch (error) {
    console.error('Scraping error:', error.message);
    return cache.isValid ? cache.data : [];
  }
}

async function getMpesaAccessToken() {
  try {
    // Create Base64 encoded auth string
    const authString = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
    
    const response = await axios.get(MPESA_AUTH_URL, {
      headers: {
        'Authorization': `Basic ${authString}`
      },
      params: {
        grant_type: 'client_credentials'
      }
    });

    return response.data.access_token;
  } catch (error) {
    console.error('MPesa Auth Error:', error.response?.data || error.message);
    throw new Error('Failed to get MPesa access token');
  }
}

function formatPhoneNumber(phoneNumber) {
  try {
    // Remove any non-digit characters
    const digitsOnly = phoneNumber.replace(/\D/g, '');
    
    // Handle different phone number formats
    if (digitsOnly.startsWith('254')) {
      return digitsOnly; // Already in correct format
    } else if (digitsOnly.startsWith('0') && digitsOnly.length === 10) {
      return `254${digitsOnly.substring(1)}`; // Convert 07... to 2547...
    } else if (digitsOnly.startsWith('7') && digitsOnly.length === 9) {
      return `254${digitsOnly}`; // Convert 7... to 2547...
    } else if (digitsOnly.length === 12 && digitsOnly.startsWith('254')) {
      return digitsOnly; // Full 12-digit international format
    }
    
    throw new Error('Invalid phone number format');
  } catch (error) {
    console.error('Phone number formatting error:', error);
    throw error;
  }
}

async function initiateMpesaPayment(phoneNumber) {
  try {
    // Validate and format phone number
    const formattedPhone = formatPhoneNumber(phoneNumber);
    console.log(`Formatted phone number: ${formattedPhone}`);

    // Step 1: Get authentication token
    const accessToken = await getMpesaAccessToken();

    // Step 2: Prepare STK push request
    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, '')
      .slice(0, -3);
    const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');

    const paymentData = {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: '5', // KSH 5
      PartyA: formattedPhone,
      PartyB: MPESA_SHORTCODE,
      PhoneNumber: formattedPhone,
      CallBackURL: CALLBACK_URL,
      AccountReference: 'BetTips',
      TransactionDesc: 'Betting tips payment'
    };

    console.log('MPesa Payment Request:', paymentData);

    // Step 3: Send STK push request
    const response = await axios.post(MPESA_STK_PUSH_URL, paymentData, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    // Check if payment request was successful
    if (response.data.ResponseCode === '0') {
      return textResponse(RESPONSES.paymentPrompt);
    } else {
      console.error('MPesa Payment failed:', response.data);
      return textResponse(RESPONSES.paymentFailure);
    }
  } catch (error) {
    if (error.message.includes('Invalid phone number format')) {
      return textResponse(RESPONSES.invalidPhone);
    }
    console.error('MPesa Payment error:', error.response?.data || error.message);
    return textResponse(RESPONSES.paymentFailure);
  }
}

// Helper functions
function parseInput(event) {
  try {
    const params = new URLSearchParams(event.body);
    return { 
      text: params.get('text') || '',
      phoneNumber: params.get('phoneNumber') || '' 
    };
  } catch (e) {
    return { 
      text: event.body?.text || '',
      phoneNumber: event.body?.phoneNumber || ''
    };
  }
}

function textResponse(body) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/plain' },
    body
  };
}

function errorResponse(error) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/plain' },
    body: error.message.includes('Timeout') ? RESPONSES.timeout : RESPONSES.error
  };
}cd 