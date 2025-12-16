/**
 * oneJournal - Main Application Entry Point
 */

// Import styles
import './styles/main.css';
import './styles/themes/light.css';
import './styles/themes/dark.css';
import './styles/themes/epaper.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/editor.css';

// Import modules
import { initTheme } from './modules/theme.js';
import { initRouter, navigateTo, getCurrentNotebookId } from './modules/router.js';
import { initStorage } from './modules/storage.js';
import { initSettings } from './components/settingsMode.js';
import { initOverview } from './components/overviewMode.js';
import { initModals, showCreateNoteModal } from './components/modals.js';
import { initSidebar } from './components/sidebar.js';
import { initRecycleBin } from './components/recycleBinMode.js';

// Application state
const app = {
  initialized: false,
  currentNote: null,
  sidebarCollapsed: false,
};

/**
 * Initialize the application
 */
async function init() {
  console.log('oneJournal initializing...');

  // Initialize storage (IndexedDB)
  await initStorage();

  // Initialize theme system
  await initTheme();

  // Initialize router
  initRouter();

  // Initialize components
  initSettings();
  initOverview();
  initModals();
  initSidebar();
  initRecycleBin();

  // Set up event listeners
  setupEventListeners();

  // Navigate to overview by default
  navigateTo('overview');

  // Mark as initialized
  app.initialized = true;
  console.log('oneJournal ready!');
}

/**
 * Set up global event listeners
 */
function setupEventListeners() {
  // Menu button (toggle sidebar)
  const menuBtn = document.getElementById('menu-btn');
  if (menuBtn) {
    menuBtn.addEventListener('click', toggleSidebar);
  }

  // Overview button
  const overviewBtn = document.getElementById('nav-overview');
  if (overviewBtn) {
    overviewBtn.addEventListener('click', () => {
      navigateTo('overview');
    });
  }

  // Settings button
  const settingsBtn = document.getElementById('nav-settings');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      navigateTo('settings');
    });
  }

  // Recycle bin button
  const recycleBinBtn = document.getElementById('recycle-bin-btn');
  if (recycleBinBtn) {
    recycleBinBtn.addEventListener('click', () => {
      navigateTo('recyclebin');
    });
  }

  // New note button
  const newNoteBtn = document.getElementById('new-note-btn');
  if (newNoteBtn) {
    newNoteBtn.addEventListener('click', handleNewNote);
  }
}

/**
 * Toggle sidebar visibility
 */
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    app.sidebarCollapsed = !app.sidebarCollapsed;
    if (app.sidebarCollapsed) {
      sidebar.style.display = 'none';
    } else {
      sidebar.style.display = 'flex';
    }
  }
}

/**
 * Handle new note creation
 */
function handleNewNote() {
  // Get current notebook ID if viewing a notebook
  const notebookId = getCurrentNotebookId();
  // Show modal with notebook context
  showCreateNoteModal(notebookId);
}

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Export for debugging
window.__oneJournal = app;
