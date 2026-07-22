const REQUEST_TIMEOUT_MS = 10_000;

export function withTimeout(operation, timeoutMs = REQUEST_TIMEOUT_MS, message = 'Homebridge UI request timed out') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

export function loadJuneConfig(homebridge) {
  return withTimeout(homebridge.getPluginConfig());
}

export async function saveJuneConfig(homebridge, config) {
  await withTimeout(homebridge.updatePluginConfig(config));
  await withTimeout(homebridge.savePluginConfig());
}
