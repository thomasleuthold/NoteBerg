<?php
declare(strict_types=1);

/**
 * Admin panel for the AI endpoint policy.
 *
 * Plain PHP and one small script rather than a Vue component: the app ships a
 * single bundled entry (js/noteberg-main.mjs) that boots the whole note editor,
 * and loading it here to render a textarea would pull the entire application
 * into every admin settings page. The panel is two controls.
 */

// Nextcloud applies its CSP nonce and a ?v= cache-buster to scripts added this
// way. Note the buster is suppressed when the instance runs with 'debug' => true
// (TemplateLayout::getVersionHashSuffix), so on a dev instance a changed admin
// script needs a hard reload — Apache's shipped .htaccess gives every .js a
// six-month max-age. That is dev-only; packaged installs get the version.
\OCP\Util::addScript('noteberg', 'noteberg-admin');

$appConfig = \OCP\Server::get(\OCP\IAppConfig::class);
$raw = $appConfig->getValueString('noteberg', \OCA\NoteBerg\EndpointPolicy::CONFIG_KEY, '');
$entries = \OCA\NoteBerg\EndpointPolicy::parse($raw);
$allowReplicate = $appConfig->getValueBool(
    'noteberg',
    \OCA\NoteBerg\EndpointPolicy::CONFIG_KEY_REPLICATE,
    false
);
?>
<div id="noteberg-admin" class="section">
     <h3><?php p($l->t('Permitted AI endpoints')); ?></h3>

    <p class="settings-hint">
        <?php p($l->t('AI inference requests make this server open an outbound connection to a provider each user chooses. Nothing below is permitted by default, until you allow something here.')); ?>
    </p>

    <p class="settings-hint">
        <?php p($l->t('Users pick an endpoint from this list. It covers any server speaking the OpenAI API (a local model, a self-hosted gateway, or a cloud provider).')); ?>
    </p>

    <p class="settings-hint">
        <?php p($l->t('One entry per line. Write a hostname (model.example.org) to permit HTTPS on that host, or a full URL (https://model.example.org/v1, http://model.lan:8080) to pin the scheme, port and path prefix. Lines starting with # are ignored. Wildcards are not supported and each entry names one host.')); ?>
    </p>

    <textarea id="noteberg-allowed-endpoints"
              rows="8"
              spellcheck="false"
              style="width: 100%; max-width: 48em; font-family: monospace;"
              aria-describedby="noteberg-admin-status"><?php p($raw); ?></textarea>

    <p class="settings-hint">
        <?php
        // A switch rather than a list entry, because there is no URL to choose:
        // this provider's host is fixed in the app, users are never shown an
        // endpoint field for it, and the request address is filled in by the
        // client. The administrator's decision is whether the provider may be
        // used at all, which is what this asks — and it spares them having to
        // discover and transcribe a hostname that was never a user's to pick.
        p($l->t('Replicate is configured with a fixed URL (https://api.replicate.com/v1). Decide to allow or not Replicate as a AI provider.'));
        ?>
    </p>

    <p>
        <input type="checkbox"
               id="noteberg-allow-replicate"
               class="checkbox"
               <?php if ($allowReplicate) { p('checked'); } ?> />
        <label for="noteberg-allow-replicate"><?php p($l->t('Allow Replicate as a provider')); ?></label>
    </p>

    <p class="settings-hint" id="noteberg-admin-current">
        <?php
        // Counts the Replicate switch alongside the listed endpoints: this line
        // sits below both controls and summarises the whole policy, so leaving
        // the switch out would report "no endpoints permitted" on an instance
        // where Replicate is in fact allowed.
        $permitted = count($entries) + ($allowReplicate ? 1 : 0);
        if ($permitted === 0) { ?>
            <strong><?php p($l->t('No endpoints permitted.')); ?></strong>
        <?php } else { ?>
            <?php p($l->n('%n endpoint permitted.', '%n endpoints permitted.', $permitted)); ?>
        <?php } ?>
    </p>
    <hr/>
    <p>
        <button id="noteberg-admin-save" class="button primary"><?php p($l->t('Save')); ?></button>
        <span id="noteberg-admin-status" role="status" aria-live="polite" style="margin-inline-start: 1em;"></span>
    </p>
</div>

<?php
$aiPolicy = \OCP\Server::get(\OCA\NoteBerg\AiPolicy::class);
$mode = $aiPolicy->mode();
$isCentral = $mode === \OCA\NoteBerg\AiPolicy::MODE_CENTRAL;
$limit = $aiPolicy->monthlyLimit(\OCA\NoteBerg\AiPolicy::TASK_RECOGNITION);
$task = \OCA\NoteBerg\AiPolicy::TASK_RECOGNITION;
// Read here rather than mid-markup: two controls below depend on it — the
// provider select and whether the endpoint row is shown — and a variable
// assigned inside one of them is easy to reorder into being undefined.
$provider = $aiPolicy->taskSetting($task, 'provider');
?>
<div id="noteberg-admin-mode" class="section">
    <h3><?php p($l->t('Who provides the AI connection and model configuration')); ?></h3>

    <p class="settings-hint">
        <?php p($l->t('Either every user brings their own provider account, or this instance uses one account you configure here. The two are exclusive: there is no mixed mode, so it is always clear whose account is paying.')); ?>
    </p>

    <p>
        <input type="radio" name="noteberg-ai-mode" id="noteberg-mode-byo" class="radio"
               value="byo" <?php if (!$isCentral) { p('checked'); } ?> />
        <label for="noteberg-mode-byo"><?php p($l->t('Users bring their own account, API key, and configuration')); ?></label>
    </p>
    <p>
        <input type="radio" name="noteberg-ai-mode" id="noteberg-mode-central" class="radio"
               value="central" <?php if ($isCentral) { p('checked'); } ?> />
        <label for="noteberg-mode-central"><?php p($l->t('This instance uses one central account and configuration')); ?></label>
    </p>

    <?php
    // `hidden` rather than a style attribute: p() escapes its argument, so
    // p('style="display:none"') emits style=&quot;display:none&quot; — inert text
    // rather than markup, leaving the block visible on load in BYO mode. A bare
    // attribute name has nothing for htmlspecialchars to escape and survives
    // intact, which is why the checked/selected attributes below work.
    ?>
    <div id="noteberg-central-fields" <?php if (!$isCentral) { p('hidden'); } ?>>
        <p class="settings-hint">
            <?php p($l->t('These settings replace every user\'s own. Users cannot see there own, if there were any, and the model is enforced on the server so it cannot be bypassed.')); ?>
        </p>

        <p>
            <label for="noteberg-central-provider"><?php p($l->t('Provider')); ?></label><br/>
            <?php
            // A provider the allowlist does not permit cannot run, so offering
            // it would let an administrator save a configuration that silently
            // never works — the same reasoning that makes the per-user endpoint
            // field a dropdown of permitted values rather than a text box.
            //
            // OpenAI-compatible needs at least one listed endpoint; Replicate
            // needs its switch. A stored-but-no-longer-permitted provider is
            // still shown, labelled, so a configuration made before a policy
            // change is visible rather than silently blank — again mirroring the
            // per-user form.
            $openAiUsable = count($entries) > 0;
            $replicateUsable = $allowReplicate;
            ?>
            <select id="noteberg-central-provider">
                <?php if ($openAiUsable || $provider !== 'replicate') { ?>
                    <option value="openai" data-requires="openai"
                        <?php if ($provider !== 'replicate') { p('selected'); } ?>
                        <?php if (!$openAiUsable) { p('disabled'); } ?>>
                        <?php p($openAiUsable
                            ? $l->t('OpenAI-compatible')
                            : $l->t('OpenAI-compatible — no endpoints permitted yet')); ?>
                    </option>
                <?php } ?>
                <?php if ($replicateUsable || $provider === 'replicate') { ?>
                    <option value="replicate" data-requires="replicate"
                        <?php if ($provider === 'replicate') { p('selected'); } ?>
                        <?php if (!$replicateUsable) { p('disabled'); } ?>>
                        <?php p($replicateUsable
                            ? $l->t('Replicate')
                            : $l->t('Replicate — not permitted above')); ?>
                    </option>
                <?php } ?>
            </select>
        </p>

        <?php
        // Replicate has no endpoint to choose: its host is a constant compiled
        // into the client, filled into the stored endpoint by the app rather
        // than typed. Showing the field would invite an administrator to set a
        // value that is never used — the same reason the per-user settings form
        // hides it (settingsMode.js). The admin's decision for Replicate is the
        // allowlist switch above, not an address.
        ?>
        <p id="noteberg-central-endpoint-row" <?php if ($provider === 'replicate') { p('hidden'); } ?>>
            <label for="noteberg-central-endpoint"><?php p($l->t('Endpoint')); ?></label><br/>
            <input type="url" id="noteberg-central-endpoint" style="width:100%;max-width:32em"
                   value="<?php p($aiPolicy->taskSetting($task, 'endpoint')); ?>" />
            <span class="settings-hint"><?php p($l->t('Must be one the allowlist above.')); ?></span>
        </p>

        <?php
        // Between the endpoint and the model: the three are one credential —
        // where to connect, with what authority, and what to ask for — and an
        // administrator fills them in that order. Sitting after the rendering
        // parameters below, it read as an afterthought detached from the
        // endpoint it belongs to.
        ?>
        <p>
            <label for="noteberg-central-key"><?php p($l->t('API key')); ?></label><br/>
            <input type="password" id="noteberg-central-key" style="width:100%;max-width:32em"
                   autocomplete="new-password"
                   placeholder="<?php p($aiPolicy->taskSetting($task, 'api_key') !== ''
                       ? $l->t('Configured — enter a new to replace')
                       : $l->t('Not set')); ?>" />
            <span class="settings-hint"><?php p($l->t('Stored encrypted and never sent to a browser.')); ?></span>
        </p>

        <p>
            <label for="noteberg-central-model"><?php p($l->t('Model')); ?></label><br/>
            <input type="text" id="noteberg-central-model" style="width:100%;max-width:32em"
                   value="<?php p($aiPolicy->taskSetting($task, 'model')); ?>" />
        </p>

        <?php
        // A separate field, mirroring the client. Replicate addresses community
        // models by version hash and only its own official models resolve by
        // owner/name alone, so folding the version into the model string would
        // make every community model unusable — the request path is built from
        // the two independently (replicateBackend.buildPredictionUrl).
        //
        // Shown for every provider rather than only Replicate: the panel is
        // server-rendered, so hiding it would need the same JS toggle as the
        // central block, and its own hint already says when it applies.
        ?>
        <p id="noteberg-central-version-row">
            <label for="noteberg-central-version"><?php p($l->t('Model version')); ?></label><br/>
            <input type="text" id="noteberg-central-version" style="width:100%;max-width:32em"
                   value="<?php p($aiPolicy->taskSetting($task, 'replicate_version')); ?>" />
            <span class="settings-hint"><?php p($l->t('Replicate only. Community models need the version hash; leave empty for official models addressed by owner/name.')); ?></span>
        </p>

        <p>
            <label for="noteberg-central-language"><?php p($l->t('Language')); ?></label><br/>
            <select id="noteberg-central-language">
                <?php
                $lang = $aiPolicy->taskSetting($task, 'language');
                // Mirrors the client's list (settingsMode.js). "auto" is the
                // default for the same reason: a wrong language assertion makes
                // a model rewrite foreign words rather than transcribe them.
                $languages = [
                    'auto' => $l->t('Detect automatically'),
                    'en-US' => 'English',
                    'de-DE' => 'Deutsch',
                    'fr-FR' => 'Français',
                    'es-ES' => 'Español',
                    'it-IT' => 'Italiano',
                    'ja-JP' => '日本語',
                    'zh-CN' => '中文',
                ];
                foreach ($languages as $code => $label) { ?>
                    <option value="<?php p($code); ?>"
                        <?php if ($lang === $code || ($lang === '' && $code === 'auto')) { p('selected'); } ?>>
                        <?php p($label); ?>
                    </option>
                <?php } ?>
            </select>
        </p>

        <p>
            <label for="noteberg-central-prompt"><?php p($l->t('Recognition prompt')); ?></label><br/>
            <textarea id="noteberg-central-prompt" rows="6" spellcheck="false"
                      style="width:100%;max-width:48em;font-family:monospace"><?php p($aiPolicy->taskSetting($task, 'prompt')); ?></textarea>
            <span class="settings-hint">
                <?php
                // Empty means the built-in default, which is the same contract
                // the per-user field has: a deployment that never touches this
                // keeps receiving prompt improvements with each release.
                p($l->t('Leave empty to use the built-in default, which is kept up to date. The placeholders {{regionList}}, {{language}}, {{punctuation}}, {{breaks}} and {{shape}} are filled in per run — removing one stops that setting reaching the model.'));
                ?>
            </span>
        </p>

        <?php
        // The rendering parameters. Per-device while users configure their own
        // account, but under central management the whole configuration is the
        // administrator's — leaving these three editable in the user's settings
        // while everything around them was fixed read as broken. 0 means unset
        // and the client uses its built-in default, which is what the
        // placeholders state.
        $edge = $aiPolicy->taskNumber($task, 'max_image_edge');
        $tokens = $aiPolicy->taskNumber($task, 'max_tokens');
        $timeout = $aiPolicy->taskNumber($task, 'timeout_seconds');
        ?>
        <p>
            <label for="noteberg-central-image-edge"><?php p($l->t('Maximum image size')); ?></label><br/>
            <input type="number" id="noteberg-central-image-edge" min="256" max="4096" step="1"
                   placeholder="1600" value="<?php p($edge > 0 ? (string)$edge : ''); ?>" />
            <span class="settings-hint"><?php p($l->t('Longest edge of each image sent, in pixels. A larger value makes small handwriting legible but costs roughly quadratic time and tokens. Empty uses the default (1600).')); ?></span>
        </p>

        <p>
            <label for="noteberg-central-max-tokens"><?php p($l->t('Maximum response length')); ?></label><br/>
            <input type="number" id="noteberg-central-max-tokens" min="256" max="32000" step="1"
                   placeholder="8000" value="<?php p($tokens > 0 ? (string)$tokens : ''); ?>" />
            <span class="settings-hint"><?php p($l->t('Token limit for the model\'s reply. A page of handwriting needs several hundred; a low limit stops a model that repeats itself instead of transcribing. Empty uses the default (8000).')); ?></span>
        </p>

        <p>
            <label for="noteberg-central-timeout"><?php p($l->t('Recognition timeout')); ?></label><br/>
            <input type="number" id="noteberg-central-timeout" min="5" max="600" step="1"
                   placeholder="120" value="<?php p($timeout > 0 ? (string)$timeout : ''); ?>" />
            <span class="settings-hint"><?php p($l->t('Seconds to wait for one page. Raise for reasoning models or a local model on CPU. The server caps this at 600 s, and a value above the web server\'s own timeout needs that raised too. Empty uses the default (120).')); ?></span>
        </p>

        <?php
        // Inside the central block, because that is the only mode where it is a
        // spend control: the account being charged is the instance's. Under BYO
        // each user pays for their own requests, so a cap set by the
        // administrator would be limiting how much of the user's own money the
        // user may spend — which the label above does not lead anyone to expect.
        //
        // Enforcement in RecognitionController stays mode-independent on
        // purpose: an instance that set a cap and then switched to BYO should
        // not silently become unbounded. The field simply stops being offered.
        ?>
        <p>
            <label for="noteberg-monthly-limit"><?php p($l->t('Monthly pages per user')); ?></label><br/>
            <input type="number" id="noteberg-monthly-limit" min="0" step="1"
                   value="<?php p((string)$limit); ?>" />
            <span class="settings-hint">
                <?php
                // Named "pages" because recognition sends exactly one request
                // per page, which is the unit a user recognises. Zero is
                // unlimited rather than blocked: this bounds a feature already
                // permitted by the allowlist above, and a cap that denied
                // everything by default would make the feature look broken
                // rather than unconfigured.
                p($l->t('0 means no limit. Recognition sends one request per page.'));
                ?>
            </span>
        </p>
    </div>

    <hr/>
    <p>
        <button id="noteberg-mode-save" class="button primary"><?php p($l->t('Save')); ?></button>
        <span id="noteberg-mode-status" role="status" aria-live="polite" style="margin-inline-start: 1em;"></span>
    </p>
</div>

<?php
// ── AI usage ───────────────────────────────────────────────────────────────
//
// Rendered server-side for the current month, then re-rendered by the picker.
// Both paths exist on purpose: the table must be readable before any script
// runs, since it is the one part of this panel that reports rather than
// configures — an administrator opening the page to check spend should not need
// JS to have loaded to see how much the instance has spent.
$usageReport = \OCP\Server::get(\OCA\NoteBerg\UsageReport::class);
$usagePeriods = $usageReport->periods($task);
$usagePeriod = \OCA\NoteBerg\UsageCounter::periodKey();
$usage = $usageReport->forPeriod($task, $usagePeriod);
?>
<div id="noteberg-admin-usage" class="section">
    <?php
    // No month in the heading: the picker below names the period being shown,
    // and a heading that repeated it would be a second thing to keep in step
    // with the selection — which is exactly what went stale when the two
    // disagreed.
    ?>
    <h3><?php p($l->t('AI usage')); ?></h3>

    <p class="settings-hint">
        <?php
        // "Pages" rather than "requests": recognition sends exactly one request
        // per page, and the cap above is already worded that way. Two names for
        // one number on the same screen would read as two different numbers.
        p($l->t('AI requests sent, per user. Also failed AI request count here and for the usage cap, as requests that reach the provider may billed too.'));
        ?>
    </p>

    <p>
        <label for="noteberg-usage-period"><?php p($l->t('Month')); ?></label>
        <select id="noteberg-usage-period">
            <?php foreach ($usagePeriods as $periodKey) { ?>
                <option value="<?php p($periodKey); ?>"
                    <?php if ($periodKey === $usagePeriod) { p('selected'); } ?>>
                    <?php p($usageReport->label($periodKey)); ?>
                </option>
            <?php } ?>
        </select>
    </p>

    <?php
    // A bounded, scrolling viewport rather than a table that grows the settings
    // page without limit: every account gets a row, so on an instance with many
    // users the section would otherwise push everything below it off screen —
    // and this is the last section, so that would be the page's whole footer.
    ?>
    <div id="noteberg-usage-scroll"
         style="max-height:24em;overflow:auto;max-width:48em;border:1px solid var(--color-border);border-radius:var(--border-radius-large);">
        <table style="width:100%;border-collapse:collapse;">
            <thead>
                <tr>
                    <?php
                    // The header stays put while the body scrolls: a column of
                    // bare numbers is unreadable once its heading has gone. Made
                    // sticky rather than split into a second table, which would
                    // need its column widths kept in sync with the body's by
                    // hand.
                    $th = 'position:sticky;top:0;z-index:1;'
                        . 'background:var(--color-main-background);padding:.5em .75em;'
                        . 'border-bottom:1px solid var(--color-border);text-align:';
                    ?>
                    <th style="<?php p($th); ?>start;"><?php p($l->t('User')); ?></th>
                    <th style="<?php p($th); ?>end;"><?php p($l->t('Pages sent')); ?></th>
                </tr>
            </thead>
            <tbody id="noteberg-usage-rows">
                <?php
                // The rows live in their own partial because the JS picker
                // rebuilds exactly this fragment: one markup definition, so the
                // server-rendered table and a re-rendered one cannot drift.
                include __DIR__ . '/usage-rows.php';
                ?>
            </tbody>
        </table>
    </div>

    <p class="settings-hint" id="noteberg-usage-summary">
        <?php include __DIR__ . '/usage-summary.php'; ?>
    </p>
</div>
