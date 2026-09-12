const status = document.querySelector('#status');
const signIn = document.querySelector('#sign-in');
const account = document.querySelector('#account');
async function load() {
  try {
    const response = await fetch('/api/me');
    const data = await response.json();
    if (response.status === 401) { signIn.hidden = false; status.textContent = ''; return; }
    if (!response.ok) throw new Error(data.error || 'Unable to load your account.');
    account.hidden = false;
    document.querySelector('#welcome').textContent = `Welcome, ${data.user.name}.`;
    status.textContent = '';
  } catch (error) { status.textContent = error.message; }
}
async function authPost(path, body) {
  const response = await fetch(`/api/auth/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'Sign-in failed. Please try again.');
  return data;
}
signIn.addEventListener('click', async () => {
  signIn.disabled = true;
  try {
    const data = await authPost('sign-in/social', { provider: 'google', callbackURL: '/' });
    if (!data.url) throw new Error('Google sign-in is unavailable.');
    window.location.assign(data.url);
  } catch (error) { status.textContent = error.message; signIn.disabled = false; }
});
document.querySelector('#sign-out').addEventListener('click', async () => {
  try { await authPost('sign-out', {}); window.location.reload(); }
  catch (error) { status.textContent = error.message; }
});
load();
