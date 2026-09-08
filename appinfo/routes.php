<?php
return [
    'routes' => [
        ['name' => 'page#index', 'url' => '/', 'verb' => 'GET'],
        // Recognition passthrough proxy — the NC build cannot reach a vision
        // endpoint from the browser (CORS, and HTTPS pages cannot call a
        // plain-HTTP local model). See RecognitionController.
        ['name' => 'recognition#proxy', 'url' => '/api/recognition/proxy', 'verb' => 'POST'],
        // Asynchronous variant of the same call. dispatch() answers immediately
        // and does the upstream work after closing the browser connection, so a
        // slow model cannot be cut short by a web-server timeout this app has no
        // way to raise; collect() picks up the result. See RecognitionController.
        ['name' => 'recognition#dispatch', 'url' => '/api/recognition/dispatch', 'verb' => 'POST'],
        ['name' => 'recognition#collect', 'url' => '/api/recognition/collect', 'verb' => 'POST'],
        // Per-user recognition configuration. The endpoint and model live here
        // because the request is issued by the server, so they must be resolved
        // in the server's frame of reference — and the API key because the NC
        // build has no secure browser storage for it.
        ['name' => 'recognitionConfig#show', 'url' => '/api/recognition/config', 'verb' => 'GET'],
        ['name' => 'recognitionConfig#update', 'url' => '/api/recognition/config', 'verb' => 'POST'],
        ['name' => 'recognitionConfig#destroy', 'url' => '/api/recognition/config', 'verb' => 'DELETE'],
        // Instance-wide allowlist of AI endpoints users may configure.
        // Admin-only (AuthorizedAdminSetting on the controller): this is what
        // decides whether the server may open outbound connections at all, so a
        // user reaching it would defeat the control. See EndpointPolicy.
        ['name' => 'adminConfig#show', 'url' => '/api/admin/endpoints', 'verb' => 'GET'],
        ['name' => 'adminConfig#update', 'url' => '/api/admin/endpoints', 'verb' => 'POST'],
        // Whether users bring their own AI account or use the administrator's,
        // the central settings that go with the latter, and the monthly request
        // cap. Separate from the allowlist above: that decides what the server
        // may reach, this decides who pays. See AiPolicy.
        ['name' => 'adminConfig#updateMode', 'url' => '/api/admin/ai-mode', 'verb' => 'POST'],
        // Per-user AI spend for one month. Admin-only for the same reason the
        // cap above is: it reports what the instance's own account was charged,
        // and it names every user while doing so.
        ['name' => 'adminConfig#usage', 'url' => '/api/admin/usage', 'verb' => 'GET'],
    ],
];
