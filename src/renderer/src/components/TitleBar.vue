<template>
  <div class="titlebar">
    <div class="titlebar-drag">
      <span class="titlebar-logo glow-gold">⚔️ Krashland<span v-if="version" class="titlebar-version"> ({{ version }})</span></span>
    </div>
    <div class="titlebar-controls">
      <button class="tb-btn" @click="minimize" title="Réduire">─</button>
      <button class="tb-btn" @click="maximizeToggle" title="Agrandir">▢</button>
      <button class="tb-btn tb-close" @click="close" title="Fermer">✕</button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'

const version = ref('')

function minimize() { window.krash.window.minimize() }
function maximizeToggle() { window.krash.window.maximizeToggle() }
function close() { window.krash.window.close() }

onMounted(async () => {
  const cfg = await window.krash.config.get()
  version.value = cfg.appVersion ? `v${cfg.appVersion}` : ''
})
</script>

<style scoped>
.titlebar {
  height: var(--titlebar-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: linear-gradient(180deg, var(--bg-deep), var(--bg-void));
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  -webkit-app-region: drag; /* permet de déplacer la fenêtre frameless */
}
.titlebar-drag {
  flex: 1;
  display: flex;
  align-items: center;
  padding-left: 12px;
}
.titlebar-logo {
  font-family: var(--font-display);
  font-size: .82rem;
  font-weight: 600;
  color: var(--gold);
  letter-spacing: .04em;
}
.titlebar-version {
  font-size: .72rem;
  font-weight: 400;
  color: var(--text-dim);
  letter-spacing: 0;
}
.titlebar-controls {
  display: flex;
  -webkit-app-region: no-drag; /* les boutons doivent rester cliquables */
}
.tb-btn {
  width: 44px;
  height: var(--titlebar-height);
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: .75rem;
  cursor: pointer;
  transition: background var(--transition), color var(--transition);
}
.tb-btn:hover { background: var(--bg-card-hover); color: var(--gold-light); }
.tb-close:hover { background: #6b2d2d; color: #fff; }
</style>
