<?php
// Minimal same-origin proxy for the Olog and Shift REST services, so the browser only talks to this server.
// Works on old PHP (5.2+). Needs the curl extension or allow_url_fopen.
//   proxy.php?svc=olog&path=logs&...            -> OLOG/logs?...
//   proxy.php?svc=olog&path=tags                -> OLOG/tags
//   proxy.php?svc=olog&path=attachments/ID/FILE[:thumbnail]
//   proxy.php?svc=shift&id=N | from=&to= | type=Operations&limit=1

$services = array(
    'olog'  => 'https://olog-acc.nsls2.bnl.gov/Olog/resources',
    'shift' => 'https://shift-acc.nsls2.bnl.gov/Shift/resources/shift',
);

function fail($status, $msg) {
    header('HTTP/1.1 ' . $status);
    header('Content-Type: text/plain');
    echo $msg;
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    fail('405 Method Not Allowed', 'GET only');
}

// Parse the raw query string: PHP's $_GET rewrites "Shift.Id" to "Shift_Id", which the Olog doesn't understand.
$params = array();
foreach (explode('&', isset($_SERVER['QUERY_STRING']) ? $_SERVER['QUERY_STRING'] : '') as $pair) {
    if ($pair === '') {
        continue;
    }
    $kv = explode('=', $pair, 2);
    $params[urldecode($kv[0])] = isset($kv[1]) ? urldecode($kv[1]) : '';
}
@set_time_limit(90);
$svc = isset($params['svc']) ? $params['svc'] : '';
unset($params['svc']);
if (!isset($services[$svc])) {
    fail('400 Bad Request', 'unknown service');
}

$path = '';
if ($svc === 'olog') {
    $p = isset($params['path']) ? $params['path'] : '';
    unset($params['path']);
    if (!preg_match('#^(logs|tags|attachments/[0-9]+/[^/\\\\]+)$#', $p) || strpos($p, '..') !== false) {
        fail('400 Bad Request', 'path not allowed');
    }
    $segments = explode('/', $p);
    foreach ($segments as $i => $s) {
        $segments[$i] = str_replace('%3A', ':', rawurlencode($s)); // keep ":thumbnail"
    }
    $path = '/' . implode('/', $segments);
} else {
    $t = isset($params['type']) ? $params['type'] : '';
    unset($params['type']);
    if ($t !== '') {
        if (!preg_match('/^[A-Za-z0-9_-]+$/', $t)) {
            fail('400 Bad Request', 'bad type');
        }
        $path = '/' . $t;
    }
}

$url = $services[$svc] . $path;
if (count($params)) {
    $url .= '?' . http_build_query($params);
}

$body = false;
$err = '';
$code = 200;
$ctype = 'application/json';
if (function_exists('curl_init')) {
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, array('Accept: application/json'));
    curl_setopt($ch, CURLOPT_TIMEOUT, 60);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false); // old servers often lack current CA bundles
    $body = curl_exec($ch);
    $err = curl_error($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $ct = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    if ($ct) {
        $ctype = $ct;
    }
    curl_close($ch);
} else {
    $ctx = stream_context_create(array(
        'http' => array('header' => "Accept: application/json\r\n", 'timeout' => 60, 'ignore_errors' => true),
        'ssl' => array('verify_peer' => false),
    ));
    $body = @file_get_contents($url, false, $ctx);
    $err = $body === false ? 'file_get_contents failed (no curl extension; check allow_url_fopen/openssl)' : '';
    if (isset($http_response_header)) {
        foreach ($http_response_header as $h) {
            if (preg_match('#^HTTP/\S+\s+(\d+)#', $h, $m)) {
                $code = (int)$m[1];
            } elseif (stripos($h, 'Content-Type:') === 0) {
                $ctype = trim(substr($h, 13));
            }
        }
    }
}

if ($body === false) {
    fail('502 Bad Gateway', 'upstream unreachable: ' . $err . ' (' . $url . ')');
}

if ($code != 200) {
    header('HTTP/1.1 ' . (int)$code);
}
header('Content-Type: ' . $ctype);
if ($svc === 'olog' && strpos($path, '/attachments/') === 0) {
    header('Cache-Control: public, max-age=86400');
}
echo $body;
