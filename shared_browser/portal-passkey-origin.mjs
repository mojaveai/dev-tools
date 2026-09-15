// Check the signed client data without rewriting it. The portal still verifies
// the signature, challenge, RP ID, credential, and user verification.
export function approvalOriginAllowed(client, portalOrigin, viewerOrigin) {
  if (client.origin !== portalOrigin) return false;
  if (client.crossOrigin === true) return client.topOrigin === viewerOrigin;
  return (client.crossOrigin === undefined || client.crossOrigin === false) && client.topOrigin === undefined;
}
