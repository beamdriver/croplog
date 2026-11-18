# Croplog

A plain JavaScript (no build step, no dependencies) web app for browsing the NSLS-II Olog by shift, day, month, tag and text search. It runs entirely in the browser; a small PHP script proxies the Olog and Shift REST services.

## Layout

```
public/
  index.html   page shell
  app.js       the app (hash routing: #/shift/ID, #/day/YYYY-MM-DD, #/month/YYYY/MM, #/tags, #/tag/NAME, #/search)
  config.js    service endpoints
  styles.css   responsive styles (dark mode, calendar collapses to a list on small screens)
  proxy.php    same-origin proxy for the Olog and Shift services
```

## Deploy

Copy the contents of `public/` to any web server that can run PHP (5.2+, curl or `allow_url_fopen`). To try it locally:

```
cd public
php -S 127.0.0.1:8000
```

## Configuration

- `config.js` – `proxy` is the proxy script URL. Remove it to call the services directly; the Olog allows CORS but the Shift service does not, so shift details would then be derived from Olog entries.
- `proxy.php` – the upstream service URLs are at the top of the file. Only `GET` requests are accepted, and only the Olog paths `logs`, `tags` and `attachments/<id>/<file>` and the Shift service are reachable.
- `proxy.php` skips TLS certificate verification because old servers often lack current CA bundles. Remove the `CURLOPT_SSL_VERIFYPEER` / `verify_peer` lines if your server has them.

## How shifts relate to entries

An entry belongs to a shift if it carries that shift's ID, or if it has no shift ID and was created within the shift's start/end time.
