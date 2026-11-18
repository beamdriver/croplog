// Service endpoints. With `proxy` set, every Olog and Shift request goes through that same-origin script
// (proxy.php, next to index.html), so the browser never contacts the services directly.
// To call the services directly instead (Olog allows CORS, Shift does not), remove `proxy`.
window.CROPLOG_CONFIG = {
  proxy: 'proxy.php',
  olog: 'https://olog-acc.nsls2.bnl.gov/Olog/resources/',
  shift: 'https://shift-acc.nsls2.bnl.gov/Shift/resources/shift',
};
