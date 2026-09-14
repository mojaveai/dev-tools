// Transport and UI hints describe the originating browser's expected device.
// On the phone, discover that SAME credential locally; never widen credential IDs.
export function phoneOptions(publicKey) {
  return {
    ...publicKey,
    hints: ['client-device'],
    ...(publicKey.allowCredentials ? {
      allowCredentials: publicKey.allowCredentials.map(({transports, ...credential}) => credential),
    } : {}),
  };
}
