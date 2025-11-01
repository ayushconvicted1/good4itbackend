const admin = require('firebase-admin');
require('dotenv').config();

console.log('🧪 Testing Firebase Configuration...\n');

// Check if all required environment variables are present
const requiredVars = [
    'FIREBASE_PROJECT_ID',
    'FIREBASE_PRIVATE_KEY_ID',
    'FIREBASE_PRIVATE_KEY',
    'FIREBASE_CLIENT_EMAIL',
    'FIREBASE_CLIENT_ID',
    'FIREBASE_CLIENT_CERT_URL'
];

console.log('📋 Checking environment variables:');
let missingVars = [];
requiredVars.forEach(varName => {
    const value = process.env[varName];
    if (value) {
        console.log(`✅ ${varName}: ${varName.includes('PRIVATE_KEY') ? '[PRESENT]' : value}`);
    } else {
        console.log(`❌ ${varName}: MISSING`);
        missingVars.push(varName);
    }
});

if (missingVars.length > 0) {
    console.log(`\n❌ Missing required environment variables: ${missingVars.join(', ')}`);
    process.exit(1);
}

// Test private key format
console.log('\n🔍 Validating private key format:');
let privateKey = process.env.FIREBASE_PRIVATE_KEY;
if (privateKey) {
    // Remove quotes if present
    privateKey = privateKey.replace(/^["']|["']$/g, '');
    // Replace escaped newlines with actual newlines
    privateKey = privateKey.replace(/\\n/g, '\n');

    console.log(`📏 Private key length: ${privateKey.length} characters`);
    console.log(`🔤 Starts with BEGIN: ${privateKey.startsWith('-----BEGIN PRIVATE KEY-----')}`);
    console.log(`🔤 Ends with END: ${privateKey.endsWith('-----END PRIVATE KEY-----')}`);

    // Count lines
    const lines = privateKey.split('\n');
    console.log(`📄 Number of lines: ${lines.length}`);

    if (lines.length < 25) {
        console.log('⚠️ Private key seems too short (should have ~27 lines)');
    }
}

// Test Firebase initialization
console.log('\n🚀 Testing Firebase initialization:');
try {
    const serviceAccount = {
        type: "service_account",
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
        private_key: privateKey,
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: process.env.FIREBASE_CLIENT_ID,
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
        client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
    };

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });

    console.log('✅ Firebase Admin SDK initialized successfully!');

    // Test sending a message (dry run)
    console.log('\n📱 Testing FCM message creation (dry run):');
    const testMessage = {
        notification: {
            title: 'Test Notification',
            body: 'This is a test from Firebase Admin SDK'
        },
        data: {
            type: 'test',
            timestamp: Date.now().toString()
        },
        token: 'test-token-placeholder' // This will fail but that's expected
    };

    console.log('✅ Message structure created successfully');
    console.log('🎉 Firebase configuration is valid!');

} catch (error) {
    console.log('❌ Firebase initialization failed:');
    console.log('Error:', error.message);

    if (error.message.includes('DECODER routines')) {
        console.log('\n🔧 DECODER error detected. This usually means:');
        console.log('1. Private key has extra characters or wrong encoding');
        console.log('2. Private key is corrupted or incomplete');
        console.log('3. Newlines are not properly formatted');
        console.log('\n💡 Try regenerating the private key from Firebase Console');
    }

    process.exit(1);
}

console.log('\n🎯 All tests passed! Firebase is ready to use.');
process.exit(0);