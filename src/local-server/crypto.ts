import sodium from 'libsodium-wrappers';

/**
 * Verify 72B wire signature = base64(BLAKE2b(pubkey,8) || Ed25519(sig))
 * Match ge/e.java:c and rb/g LibsodiumCipher
 */
export async function verifyCompanionSignature(
  messageJson: string,
  b64Signature: string,
  companionPublicKeyB64: string, // oven's stored companion publicSigningKey? or derived from seed
): Promise<boolean> {
  await sodium.ready;
  if (!b64Signature) return false;
  try {
    const sigBytes = Buffer.from(b64Signature, 'base64'); // 72
    if (sigBytes.length !== 72) return false;
    const fp = sigBytes.subarray(0, 8);
    const sig = sigBytes.subarray(8); // 64
    const pub = Buffer.from(companionPublicKeyB64, 'base64');
    // check fingerprint matches pub
    const expectedFp = sodium.crypto_generichash(8, pub);
    if (!Buffer.from(expectedFp).equals(fp)) return false;
    // verify detached: payload is JSON with signature:"" (ordered)
    const payload = Buffer.from(messageJson, 'utf8');
    return sodium.crypto_sign_verify_detached(sig, payload, pub);
  } catch {
    return false;
  }
}

export async function fingerprintForPubkeyBase64(pubB64: string): Promise<string> {
  await sodium.ready;
  const pub = Buffer.from(pubB64, 'base64');
  return Buffer.from(sodium.crypto_generichash(8, pub)).toString('base64');
}

// For local server we also need to be able to sign as the companion (when we impersonate phone to oven)
// and optionally as oven (if we want to synthesize telemetry). Reuse protocol.signFrame logic.
