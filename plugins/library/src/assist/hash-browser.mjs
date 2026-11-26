import sha256 from 'fast-sha256';
const encoder=new TextEncoder();
export const hash=value=>Array.from(sha256.hash(encoder.encode(JSON.stringify(value))),n=>n.toString(16).padStart(2,'0')).join('');
