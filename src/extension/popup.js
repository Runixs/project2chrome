const payloadInput = document.getElementById("payload");
const syncButton = document.getElementById("sync");
const statusEl = document.getElementById("status");

if (!(payloadInput instanceof HTMLTextAreaElement) || !(syncButton instanceof HTMLButtonElement) || !(statusEl instanceof HTMLElement)) {
  throw new Error("Popup elements not found");
}

syncButton.addEventListener("click", async () => {
  statusEl.textContent = "Syncing...";

  let payload;
  try {
    payload = JSON.parse(payloadInput.value);
  } catch {
    statusEl.textContent = "Invalid JSON payload";
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "project2chrome.sync",
      payload
    });

    if (!response?.ok) {
      statusEl.textContent = `Sync failed: ${response?.error ?? "unknown error"}`;
      return;
    }

    statusEl.textContent = "Sync completed";
  } catch (error) {
    statusEl.textContent = `Sync failed: ${String(error)}`;
  }
});
