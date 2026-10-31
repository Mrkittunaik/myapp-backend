// Remote push through Expo's push service. Needs the phone to have registered a token (development/production build).
async function sendPush(token, { title, body, channelId, to }) {
  if (!token || !/^Expo(nent)?PushToken\[/.test(token)) return false;
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ to: token, title, body, channelId, sound: 'default', data: { to } }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch { return false; }
}
module.exports = { sendPush };
