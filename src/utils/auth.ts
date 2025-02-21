import crypto from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';

// Define the paths to your key files
const privateKeyPath = path.resolve(__dirname, './secrets/private.pem');
const publicKeyPath = path.resolve(__dirname, './secrets/public.pem');

// Read the keys from the files
const privateKey = readFileSync(privateKeyPath, 'utf8');
const publicKey = readFileSync(publicKeyPath, 'utf8');

export { privateKey, publicKey };

export function generateToken(apiKey: string): string {
  // First check: verify the API key matches
  if (apiKey !== process.env.NEXT_PUBLIC_API_KEY) {
    throw new Error('Invalid API key');
  }

  // If API key is valid, use the private key to sign a token
  const timestamp = Date.now();
  const signer = crypto.createSign('SHA256');
  signer.update(timestamp.toString());
  const signature = signer.sign(privateKey, 'base64');  // Uses private key from file
  
  return Buffer.from(JSON.stringify({ timestamp, signature })).toString('base64');
}

export function verifyToken(token: string): boolean {
  try {
    const { timestamp, signature } = JSON.parse(Buffer.from(token, 'base64').toString());
    
    // Verify the signature using public key
    const verifier = crypto.createVerify('SHA256');
    verifier.update(timestamp.toString());
    return verifier.verify(publicKey, signature, 'base64');  // Uses public key from file
  } catch {
    return false;
  }
}