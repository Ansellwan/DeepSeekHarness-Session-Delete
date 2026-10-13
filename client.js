/**
 * Client half of the `dsh-session-clean` bundle.
 *
 * Registers one row in the shipped `sidebar.workspaces.session.menu.item`
 * list — the same list the built-in pin / rename / fork / archive rows live
 * in — so "Delete session" appears in every session's "…" menu at order 500
 * (after archive), including archived rows.
 *
 * The row greys itself while the session owns live work by selecting from the
 * host-provided `useSessionStatus` snapshot, the same store the sidebar's
 * "进行中" status uses. The Host re-checks before deleting, so this is
 * presentation, not enforcement.
 *
 * Structure note (the lesson from the first cut): a menu row unmounts with
 * its menu, so the confirm dialog and the result toast must NOT live inside
 * the row component. Like the shipped archive flow, they hang off the
 * frame-wide `shell.overlay` slot and talk to the row through a tiny
 * module-level request store — closing the menu cannot kill a pending dialog.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-clean',
  factory(require) {
    // Human-synced copy of package.json#version: client bundles cannot read
    // package.json at runtime. Bump together with `npm version`.
    const VERSION = '1.1.2'

    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-session-clean'
    const DICT = {
      zh: {
        menu: '删除会话',
        menuBusy: '会话运行中，无法删除',
        confirmTitle: '删除此会话？',
        confirmDesc: '将永久删除「{title}」的对话记录与本地数据，删除后无法恢复。',
        confirmNote: '正在打开的会话也能删，删完立刻从列表里消失。万一这次没能彻底删除，会先把它藏起来，并直接告诉你。',
        confirmBusy: '会话仍有进行中的工作，无法删除。',
        confirmAction: '永久删除',
        cancel: '取消',
        deleting: '正在删除…',
        done: '会话已删除',
        doneUnloaded: '会话已删除：数据已清除，列表里也不会再出现',
        doneLive: '数据已删除，但这次没能把会话彻底移除：先临时藏了起来（切到「显示已归档」能看到），重启 DSH 后彻底消失',
        failed: '删除失败：{message}',
      },
      en: {
        menu: 'Delete session',
        menuBusy: 'Session is running; deletion unavailable',
        confirmTitle: 'Delete this session?',
        confirmDesc: 'This permanently deletes “{title}” — its chat history and local data. It cannot be undone.',
        confirmNote: 'Sessions that are open right now can be deleted too, and the row disappears as soon as it is done. If a full delete is not possible this time, it is only hidden for now and you are told right away.',
        confirmBusy: 'The session still has work in progress and cannot be deleted.',
        confirmAction: 'Delete permanently',
        cancel: 'Cancel',
        deleting: 'Deleting…',
        done: 'Session deleted',
        doneUnloaded: 'Session deleted: the data is gone and it will not come back in the list',
        doneLive: 'The data is deleted, but the session itself could not be fully removed this time: it is hidden for now (visible under “show archived”) and disappears for good after a DSH restart',
        failed: 'Delete failed: {message}',
      },
    }

    const STYLE_ID = 'dsh-session-clean-style'

    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
.dsh-sd-overlay { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.45); }
.dsh-sd-dialog { width: min(400px, calc(100vw - 48px)); border-radius: 12px; border: .5px solid var(--dsw-alias-border-l2, #333); background: var(--dsw-alias-bg-layer-2, #1f1f1f); color: var(--dsw-alias-label-primary, #eee); padding: 18px; box-shadow: 0 12px 40px rgba(0,0,0,.4); }
.dsh-sd-title { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
.dsh-sd-desc { margin: 0 0 14px; font-size: 12.5px; line-height: 19px; color: var(--dsw-alias-label-secondary, #aaa); word-break: break-all; }
.dsh-sd-note { margin: -6px 0 14px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #999); }
.dsh-sd-warn { margin: 0 0 14px; font-size: 12.5px; color: var(--dsw-alias-state-error-primary, #f85149); }
.dsh-sd-footer { display: flex; justify-content: flex-end; gap: 8px; }
.dsh-sd-btn { padding: 6px 14px; border-radius: 8px; border: .5px solid var(--dsw-alias-border-l2, #444); background: transparent; color: inherit; font: inherit; font-size: 12.5px; cursor: pointer; }
.dsh-sd-btn:disabled { opacity: .55; cursor: default; }
.dsh-sd-btn[data-danger="true"] { border-color: transparent; background: var(--dsw-alias-state-error-primary, #d1242f); color: #fff; }
.dsh-sd-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 10000; padding: 8px 16px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, #1f1f1f); border: .5px solid var(--dsw-alias-border-l2, #333); color: var(--dsw-alias-label-primary, #eee); font-size: 12.5px; box-shadow: 0 6px 24px rgba(0,0,0,.35); }
.dsh-sd-toast[data-ok="false"] { color: var(--dsw-alias-state-error-primary, #f85149); }
`
      document.head.appendChild(style)
    }

    /**
     * Register one locale namespace and return its translator.
     * @param {object} ctx - the client plugin context.
     * @returns {(key: string, params?: object) => string} the translator.
     */
    function bindLocale(ctx) {
      ctx.locale.register(NS, 'zh', DICT.zh)
      ctx.locale.register(NS, 'en', DICT.en)
      return ctx.locale.bind(NS)
    }

    /* ------------------------------------------------------------------ *
     * Module-level request store: the menu row files a delete request here,
     * the shell.overlay occupant renders it. Outliving the menu is the
     * whole point.
     * ------------------------------------------------------------------ */

    /** @type {{ sessionId: string, displayTitle: string } | null} */
    let pendingRequest = null
    const pendingListeners = new Set()

    function requestDelete(sessionId, displayTitle) {
      pendingRequest = { sessionId, displayTitle }
      for (const listener of pendingListeners) listener()
    }

    function settleRequest() {
      pendingRequest = null
      for (const listener of pendingListeners) listener()
    }

    function usePendingRequest() {
      const [request, setRequest] = React.useState(pendingRequest)
      React.useEffect(() => {
        const listener = () => setRequest(pendingRequest)
        pendingListeners.add(listener)
        return () => pendingListeners.delete(listener)
      }, [])
      return request
    }

    /** Minimal trash glyph; inline so no icon package is required. */
    function TrashIcon() {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': true,
        style: { flex: 'none' },
      },
        h('path', {
          d: 'M6.5 2h3l.5 1h3v1.5H3V3h3l.5-1ZM4 5.5h8l-.6 8a1.5 1.5 0 0 1-1.5 1.4H6.1a1.5 1.5 0 0 1-1.5-1.4L4 5.5Z',
          fill: 'currentColor',
        }))
    }

    /**
     * The menu row: "Delete session" at order 500, shown for every session —
     * running sessions get a disabled row, archived rows stay deletable.
     * It only files a request; the dialog lives in the shell overlay.
     */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, useSessionStatus, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      const status = useSessionStatus((snapshot) =>
        snapshot instanceof Map ? snapshot.get(sessionId) : snapshot?.[sessionId],
      )
      const busy =
        status?.running === true ||
        (status?.pendingInteraction !== undefined && status?.pendingInteraction !== null)

      return h('button', {
        type: 'button',
        role: 'menuitem',
        disabled: busy,
        title: busy ? t('menuBusy') : undefined,
        style: busy
          ? { opacity: 0.45, cursor: 'default', color: 'var(--dsw-alias-state-error-primary, #f85149)' }
          : { color: 'var(--dsw-alias-state-error-primary, #f85149)', cursor: 'pointer' },
        onClick: () => {
          if (busy) return
          setMenuOpen(false)
          requestDelete(sessionId, displayTitle)
        },
      },
        h(TrashIcon),
        h('span', { style: { marginLeft: 8 } }, busy ? t('menuBusy') : t('menu')),
      )
    }

    /**
     * The shell.overlay occupant: nothing while no request is pending, then
     * one confirm dialog per request plus the result toast. Survives the
     * menu closing because this seat is frame-wide.
     */
    function DeleteSessionOverlay({ t }) {
      const request = usePendingRequest()
      const [deleting, setDeleting] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [toast, setToast] = React.useState(null)

      React.useEffect(() => {
        if (toast === null) return
        const timer = window.setTimeout(() => setToast(null), 3200)
        return () => window.clearTimeout(timer)
      }, [toast])

      // A fresh request opens with clean in-flight/error state.
      React.useEffect(() => {
        setError(null)
        setDeleting(false)
      }, [request?.sessionId])

      const callDelete = async (sessionId) => {
        setDeleting(true)
        setError(null)
        try {
          const response = await fetch('/_dsh-session-clean/delete', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || payload?.ok !== true) {
            throw new Error(payload?.error ?? `HTTP ${response.status}`)
          }
          // Three honest outcomes, never one blanket "deleted": the Host
          // unloaded the session for real / it stayed resident and was only
          // hidden (degraded probe) / it was already cold.
          const unloaded = payload?.unloaded === true
          const stillLive = payload?.live === true
          setToast(t(unloaded ? 'doneUnloaded' : stillLive ? 'doneLive' : 'done'))
          settleRequest()
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setDeleting(false)
        }
      }

      return h(React.Fragment, null,
        request !== null && h('div', { className: 'dsh-sd-overlay', role: 'presentation' },
          h('div', { className: 'dsh-sd-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': t('confirmTitle') },
            h('h2', { className: 'dsh-sd-title' }, t('confirmTitle')),
            h('p', { className: 'dsh-sd-desc' },
              t('confirmDesc', { title: request.displayTitle || request.sessionId })),
            h('p', { className: 'dsh-sd-note' }, t('confirmNote')),
            error !== null && h('p', { className: 'dsh-sd-warn' }, t('failed', { message: error })),
            h('div', { className: 'dsh-sd-footer' },
              h('button', {
                type: 'button', className: 'dsh-sd-btn', disabled: deleting,
                onClick: () => { if (!deleting) settleRequest() },
              }, t('cancel')),
              h('button', {
                type: 'button', className: 'dsh-sd-btn', 'data-danger': true,
                disabled: deleting,
                onClick: () => { void callDelete(request.sessionId) },
              }, deleting ? t('deleting') : t('confirmAction')),
            ),
          ),
        ),
        toast !== null && h('div', { className: 'dsh-sd-toast' }, toast),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ensureStyles()
        const t = bindLocale(ctx)

        // The stylesheet has to go away with the plugin (same contract the
        // shipped checkers enforce on every dynamic client half).
        ctx.effect(() => () => {
          document.getElementById(STYLE_ID)?.remove()
        })

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
          ctx.slots.register(
            { name: 'sidebar.workspaces.session.menu.item', id: 'dsh-session-clean', order: 500 },
            (props) => h(DeleteSessionMenuItem, { ...props, t }),
          ),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-session-clean' },
            () => h(DeleteSessionOverlay, { t }),
          ),
        )
      },
    }
  },
})
