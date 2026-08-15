/**
 * cdp-page.mjs — Native page-level CDP WebSocket helper module (Node 22 native WebSocket)
 *
 * Provides fast, page-level CDP connections without requiring Playwright context enumeration.
 */

/**
 * Fast pre-flight check to verify if Chrome CDP is available on the target port (default 2s timeout)
 */
export async function isCdpAvailable(host = 'localhost', port = 9222, timeoutMs = 2000) {
  try {
    const res = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch (e) {
    return false;
  }
}

/**
 * Fetch all open CDP tabs from Chrome
 */
export async function getOpenTabs(host = 'localhost', port = 9222) {
  try {
    const res = await fetch(`http://${host}:${port}/json`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return [];
    return await res.json();
  } catch (e) {
    return [];
  }
}

/**
 * Open a fresh page tab via CDP and connect to its page-level WebSocket
 */
export async function openCdpTab(targetUrl = 'about:blank', host = 'localhost', port = 9222) {
  const newRes = await fetch(`http://${host}:${port}/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' });
  if (!newRes.ok) {
    throw new Error(`Failed to open new CDP tab on http://${host}:${port}`);
  }
  const tab = await newRes.json();
  const wsUrl = tab.webSocketDebuggerUrl;
  if (!wsUrl) {
    throw new Error(`No webSocketDebuggerUrl returned for new tab ${tab.id}`);
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP page WebSocket connection timeout')), 5000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener('error', (err) => {
      clearTimeout(timer);
      reject(err);
    }, { once: true });
  });

  let msgId = 1;
  const pendingRequests = new Map();

  ws.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.id && pendingRequests.has(data.id)) {
        const { resolve, reject } = pendingRequests.get(data.id);
        pendingRequests.delete(data.id);
        if (data.error) {
          reject(new Error(data.error.message || 'CDP command error'));
        } else {
          resolve(data.result);
        }
      }
    } catch (e) {}
  });

  const send = (method, params = {}) => {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      pendingRequests.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return res?.result?.value;
  };

  const close = async () => {
    try {
      ws.close();
    } catch (e) {}
    try {
      await fetch(`http://${host}:${port}/json/close/${tab.id}`);
    } catch (e) {}
  };

  return { ws, tab, send, evaluate, close };
}
