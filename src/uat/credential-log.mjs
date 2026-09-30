export function credentialLog({ sharedPassword, ownerPin, passwordFromEnvironment = false, pinFromEnvironment = false } = {}) {
  const lines = [];
  if (passwordFromEnvironment) lines.push("Shared password loaded from protected environment; not logged.");
  else lines.push(`Ephemeral shared password: ${sharedPassword}`);
  if (pinFromEnvironment) lines.push("OWNER approval PIN loaded from protected environment; not logged.");
  else lines.push(`Ephemeral OWNER approval PIN: ${ownerPin}`);
  return lines;
}
