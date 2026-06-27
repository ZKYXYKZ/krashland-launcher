<template>
  <div v-if="visible" class="update-banner" :class="{ 'is-ready': phase === 'ready', 'is-error': phase === 'error' }">
    <span class="update-msg">{{ message }}</span>
    <button v-if="phase === 'ready'" class="btn-update" @click="install">
      Redémarrer pour mettre à jour
    </button>
    <button v-if="phase === 'error' || phase === 'up-to-date'" class="btn-dismiss" @click="dismiss">✕</button>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'

const phase = ref('idle') // idle | checking | available | downloading | ready | up-to-date | error
const percent = ref(0)
const dismissed = ref(false)

let removeListener = null

const visible = computed(() =>
  !dismissed.value && ['available', 'downloading', 'ready', 'error'].includes(phase.value)
)

const message = computed(() => ({
  available: 'Mise à jour disponible, téléchargement...',
  downloading: `Téléchargement de la mise à jour... ${percent.value}%`,
  ready: 'Mise à jour prête à installer.',
  error: "Erreur lors de la vérification des mises à jour (le launcher reste utilisable)."
}[phase.value] || ''))

function dismiss() { dismissed.value = true }

async function install() {
  await window.krash.update.install()
}

onMounted(() => {
  removeListener = window.krash.update.onStatus((status) => {
    phase.value = status.phase
    if (status.phase === 'downloading') percent.value = status.percent
    if (status.phase === 'available' || status.phase === 'error') dismissed.value = false
  })
})

onUnmounted(() => {
  removeListener?.()
})
</script>

<style scoped>
.update-banner {
  position: fixed;
  bottom: 70px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 50;
  display: flex;
  align-items: center;
  gap: .75rem;
  background: var(--bg-card);
  border: 1px solid var(--border-bright);
  border-radius: var(--radius-sm);
  padding: .6rem 1rem;
  font-size: .78rem;
  color: var(--text-muted);
  box-shadow: 0 8px 24px rgba(0,0,0,.4);
}
.update-banner.is-ready { border-color: var(--gold); }
.update-banner.is-error { border-color: #cc6d6d; }

.btn-update {
  padding: .4rem .8rem;
  background: linear-gradient(135deg, #b8861e, var(--gold));
  color: #0d0a04;
  border: none;
  border-radius: var(--radius-sm);
  font-size: .74rem;
  font-weight: 700;
  cursor: pointer;
}
.btn-dismiss {
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: .8rem;
}
</style>
