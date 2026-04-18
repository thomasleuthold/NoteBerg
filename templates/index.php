<?php
\OCP\Util::addStyle('noteberg', 'noteberg-styles');

// Detect Nextcloud dark mode server-side via OCP public API.
$isDark = false;
try {
    $userId = \OCP\Server::get(\OCP\IUserSession::class)->getUser()?->getUID();
    if ($userId) {
        $config = \OCP\Server::get(\OCP\IConfig::class);
        $accessibilityTheme = $config->getUserValue($userId, 'accessibility', 'theme', '');
        $isDark = ($accessibilityTheme === 'dark' || $accessibilityTheme === 'highcontrast');
        if (!$isDark) {
            $isDark = $config->getUserValue($userId, 'accessibility', 'darkmode', '0') === '1';
        }
    }
} catch (\Exception $e) {
    // Ignore — default to light
}
$initialTheme = $isDark ? 'dark' : 'light';
?>
<style>
  /* Make NoteBerg fill the Nextcloud content area */
  #content.app-noteberg {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 0;
    overflow: hidden;
  }
  #content.app-noteberg #app {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  /* Prevent our CSS from fighting Nextcloud's body/html layout */
  body, html {
    height: 100% !important;
    overflow: hidden !important;
  }

  /* ── Override Nextcloud CSS conflicts ────────────────────────────────────── */

  /* NC defines .breadcrumb as inline-flex with height:50px — reassert ours */
  #app nav.breadcrumb {
    display: flex !important;
    height: auto !important;
    align-items: center;
  }

  /* NC resets font-family to inherit everywhere — pull it back for our app */
  #app {
    font-family: var(--font-family, "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    color: var(--text-primary, #0f172a);
    font-size: 0.875rem;
    line-height: 1.6;
  }

  /* NC may override card positioning — ensure absolute-positioned buttons are anchored correctly */
  #app .note-card,
  #app .notebook-card {
    overflow: visible !important;
    position: relative !important;
  }

  /* NC adds padding/min-height/min-width to all buttons */
  #app button {
    padding: 0 !important;
    min-height: 0 !important;
    min-width: 0 !important;
    cursor: pointer !important;
    font-family: var(--font-family, inherit) !important;
    font-size: inherit !important;
  }

  /* NC overrides ::-webkit-scrollbar width to 12px */
  #app ::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }

  /* NC li.crumb styles bleed onto our list items */
  #app li {
    background-image: none !important;
    padding-inline-end: 0 !important;
    height: auto !important;
  }

  /* Restore list indentation inside the text editor (NC zeroes ol/ul padding) */
  #app .trumbowyg-editor ol,
  #app .trumbowyg-editor ul {
    padding-left: 2em !important;
    margin: 0.25em 0 !important;
  }

  /* Ensure our toolbar renders correctly */
  #app .toolbar {
    min-height: var(--toolbar-height, 60px);
    display: flex !important;
    align-items: center;
    flex-shrink: 0;
  }

  /* Ensure app-container fills remaining height */
  #app .app-container {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* NC inputs.css sets width:130px and padding:12px on div[contenteditable] —
     reset width/border/margin for all, but keep padding only for non-editor elements. */
  #app div[contenteditable] {
    width: auto !important;
    margin: 0 !important;
    border: none !important;
  }
  #app div[contenteditable]:not(.trumbowyg-editor) {
    padding: 0 !important;
  }
</style>
<div id="app" data-nc-theme="<?php p($initialTheme); ?>">
  <!-- Top Toolbar -->
  <header id="toolbar" class="toolbar">
    <div class="toolbar-left">
      <nav id="breadcrumb" class="breadcrumb" aria-label="Breadcrumb navigation">
        <button id="nav-overview" class="breadcrumb-item" aria-label="Home" title="Home">
          <!-- Icon injected by breadcrumb.js -->
        </button>
      </nav>
    </div>
    <div class="toolbar-center">
    </div>
    <div class="toolbar-right">
      <!-- No settings button in Nextcloud build -->
    </div>
  </header>

  <div class="app-container">
    <main id="main-content" class="main-content">
      <!-- Content will be rendered by router -->
    </main>
  </div>

  <!-- Footer -->
  <footer id="footer" class="footer">
    <div class="footer-left">
      <!-- No sync status in Nextcloud build -->
    </div>
    <div class="footer-right">
      <span class="app-version"></span>
    </div>
  </footer>
</div>
<!-- Vite bundle uses import.meta — must load as type="module" with CSP nonce -->
<script type="module" src="<?php p(link_to('noteberg', 'js/noteberg-main.js')); ?>" nonce="<?php p($_['cspNonce']); ?>"></script>
