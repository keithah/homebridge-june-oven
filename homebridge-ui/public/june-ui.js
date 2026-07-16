const REQUEST_TIMEOUT_MS = 10_000;

export function withTimeout(operation, timeoutMs = REQUEST_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Homebridge UI request timed out')), timeoutMs);
  });

  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

export function loadJuneConfig(homebridge) {
  return withTimeout(homebridge.getPluginConfig());
}

export async function saveJuneConfig(homebridge, config) {
  await homebridge.updatePluginConfig(config);
  await homebridge.savePluginConfig();
}
