/**
 * How sharing shows up on a notebook: who it comes from, what the user may do
 * with it, and what to do when it needs attention (DESIGN §4, §8).
 *
 * Markup is returned as strings for the overview's templates; the actions are
 * wired by attachShareNoticeActions() on whatever container holds them.
 */

import { t } from "../i18n/index.js";
import { canEdit, isShared, isShareEnded } from "../modules/sharing/sharePermissions.js";
import { escapeHtml } from "../utils/escapeHtml.js";

/** The owner as the user knows them. */
export function ownerLabel(notebook) {
  return notebook.ownerDisplayName || notebook.ownerUid || "";
}

/**
 * Badges on a notebook card or header.
 * @param {Object} notebook
 * @param {{recipients?: number}} [options] - how many people the user shares this own notebook with
 */
export function renderShareBadges(notebook, { recipients = 0 } = {}) {
  if (isShared(notebook)) {
    const access = canEdit(notebook)
      ? `<span class="share-badge share-badge--edit">${t("sharing.badge.canEdit")}</span>`
      : `<span class="share-badge share-badge--readonly">${t("sharing.badge.readOnly")}</span>`;
    return `
      <div class="share-badges">
        <span class="share-badge share-badge--owner">${t("sharing.badge.sharedBy", { owner: escapeHtml(ownerLabel(notebook)) })}</span>
        ${isShareEnded(notebook) ? "" : access}
      </div>`;
  }
  if (recipients > 0) {
    return `
      <div class="share-badges">
        <span class="share-badge share-badge--owner" title="${t("sharing.badge.sharedWith", { count: recipients })}">${t("sharing.badge.shared")}</span>
      </div>`;
  }
  return "";
}

/**
 * Notices for a shared notebook that needs the user's attention: the share is
 * gone, or some notes hold changes that can no longer be saved. Empty for
 * anything else.
 */
export function renderShareNotices(notebook) {
  if (!isShared(notebook)) return "";
  const stranded = notebook.strandedNoteIds?.length ?? 0;

  if (isShareEnded(notebook)) {
    const message =
      stranded > 0
        ? t("sharing.ended.notice", { count: stranded })
        : t("sharing.ended.noticeClean");
    return `
      <div class="share-notice share-notice--ended" role="status">
        <p class="share-notice__text">${message}</p>
        <button class="btn-secondary share-notice__action" data-share-action="dismiss" data-notebook-id="${notebook.id}">${t("sharing.ended.dismiss")}</button>
      </div>`;
  }

  if (stranded > 0) {
    return `
      <div class="share-notice share-notice--stranded" role="status">
        <p class="share-notice__text">${t("sharing.stranded.notice", { count: stranded })}</p>
        <button class="btn-secondary share-notice__action" data-share-action="discard" data-notebook-id="${notebook.id}">${t("sharing.stranded.discard")}</button>
      </div>`;
  }
  return "";
}

/**
 * Wire the notice buttons inside `root`.
 * @param {HTMLElement} root
 * @param {{dismiss: (notebookId: string) => Promise<void>, discard: (notebookId: string) => Promise<void>}} actions
 */
export function attachShareNoticeActions(root, actions) {
  for (const button of root.querySelectorAll("[data-share-action]")) {
    button.addEventListener("click", async (event) => {
      // The card around the notice opens the notebook
      event.stopPropagation();
      const handler = actions[button.dataset.shareAction];
      if (handler) await handler(button.dataset.notebookId);
    });
  }
}

/**
 * Notebooks other users want to share with the user, each with Accept and
 * Decline. The title is not known before accepting, only who offers it.
 * @param {Array<import("../modules/sharing/invitations.js").Invitation>} invitations
 */
export function renderInvitations(invitations) {
  if (invitations.length === 0) return "";
  const cards = invitations.map((invitation) => {
    const owner = escapeHtml(invitation.ownerDisplayName || invitation.ownerUid || "");
    const id = escapeHtml(invitation.shareId);
    return `
      <div class="share-notice share-invitation" role="status" data-share-id="${id}">
        <p class="share-notice__text">${t("sharing.invite.message", { owner })}</p>
        <div class="share-invitation__actions">
          <button class="btn-primary" data-invite-action="accept" data-share-id="${id}">${t("sharing.invite.accept")}</button>
          <button class="btn-secondary" data-invite-action="decline" data-share-id="${id}">${t("sharing.invite.decline")}</button>
        </div>
      </div>`;
  });
  return `<div class="share-invitations">${cards.join("")}</div>`;
}

/**
 * Wire the invitation buttons inside `root`.
 * @param {HTMLElement} root
 * @param {{accept: (shareId: string) => Promise<void>, decline: (shareId: string) => Promise<void>}} actions
 */
export function attachInvitationActions(root, actions) {
  for (const button of root.querySelectorAll("[data-invite-action]")) {
    button.addEventListener("click", async () => {
      const card = button.closest(".share-invitation");
      const buttons = card ? [...card.querySelectorAll("button")] : [button];
      for (const b of buttons) b.disabled = true;
      try {
        await actions[button.dataset.inviteAction]?.(button.dataset.shareId);
      } finally {
        for (const b of buttons) b.disabled = false;
      }
    });
  }
}
