export async function safeImport(importFn: () => Promise<any>, name: string) {
  try {
    return await importFn();
  } catch (err) {
    console.error(`Error loading ${name}:`, err);
    if (!navigator.onLine) {
      alert(`Offline Error: The module "${name}" is not available offline. Please connect to the internet to load it for the first time.`);
    } else {
      alert(`Error: Failed to load "${name}". Please check your connection and reload.`);
    }
    throw err;
  }
}
