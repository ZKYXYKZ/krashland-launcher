<template>
  <div class="onboarding">
    <div class="onboarding-card">

      <template v-if="step === 'ask'">
        <span class="ob-icon">⚔️</span>
        <h2 class="ob-title glow-gold">World of Warcraft 3.3.5 est-il déjà installé sur cet ordinateur ?</h2>
        <p class="ob-sub">On a juste besoin de savoir si tu as déjà le client, pour éviter un téléchargement complet inutile.</p>
        <div class="ob-actions">
          <button class="btn btn-gold" @click="chooseExisting">Oui, choisir l'emplacement</button>
          <button class="btn btn-outline" @click="downloadFresh">Non, télécharger le jeu</button>
        </div>
      </template>

      <template v-else-if="step === 'checking'">
        <h2 class="ob-title">Vérification des fichiers...</h2>
        <p class="ob-sub" v-if="checkedTotal">{{ checkedCount }} / {{ checkedTotal }} fichiers vérifiés</p>
        <div class="ob-spinner"><span class="spinner" /></div>
      </template>

      <template v-else-if="step === 'downloading'">
        <h2 class="ob-title">Téléchargement en cours...</h2>
        <p class="ob-sub">{{ downloadedMb }} / {{ totalMb }} Mo ({{ progressPercent }}%)</p>
        <p class="ob-sub retry-notice" v-if="retryNotice">{{ retryNotice }}</p>
        <div class="progress-track">
          <div class="progress-fill" :style="{ width: progressPercent + '%' }" />
        </div>
      </template>

      <template v-else-if="step === 'error'">
        <h2 class="ob-title">Erreur</h2>
        <p class="ob-sub error">{{ errorMsg }}</p>
        <div class="ob-actions">
          <button class="btn btn-outline" @click="step = 'ask'">Réessayer</button>
        </div>
      </template>

    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'

const emit = defineEmits(['done'])

const step = ref('ask')
const errorMsg = ref('')
const checkedCount = ref(0)
const checkedTotal = ref(0)
const downloadedBytes = ref(0)
const totalBytes = ref(0)
const retryNotice = ref('')

let removeProgressListener = null

const downloadedMb = computed(() => (downloadedBytes.value / 1024 / 1024).toFixed(0))
const totalMb = computed(() => (totalBytes.value / 1024 / 1024).toFixed(0))
const progressPercent = computed(() => {
  if (!totalBytes.value) return 0
  return Math.min(100, Math.round((downloadedBytes.value / totalBytes.value) * 100))
})

// "Oui" (déjà installé) et "Non" (télécharger) mènent au même flux technique :
// on choisit un dossier puis on lance syncGame(), qui compare au manifest et ne
// télécharge que ce qui manque. Si le dossier choisi contient déjà tous les
// fichiers (cas "Oui"), rien n'est téléchargé. Si le dossier est vide (cas "Non"),
// tout est téléchargé. La distinction Oui/Non n'est donc qu'une question de
// clarté pour le joueur, pas une branche de code différente.
async function chooseExisting() {
  const res = await window.krash.game.chooseFolder()
  if (!res.ok) return
  await runCheck()
}

async function downloadFresh() {
  const res = await window.krash.game.chooseFolder()
  if (!res.ok) return
  await runCheck()
}

async function runCheck() {
  step.value = 'checking'
  errorMsg.value = ''
  const res = await window.krash.game.sync()
  if (res.ok) {
    emit('done')
  } else {
    step.value = 'error'
    errorMsg.value = res.error || 'Erreur de synchronisation'
  }
}

onMounted(() => {
  removeProgressListener = window.krash.game.onSyncProgress((progress) => {
    if (progress.phase === 'checking') {
      step.value = 'checking'
      checkedCount.value = progress.checked
      checkedTotal.value = progress.total
    } else if (progress.phase === 'downloading') {
      step.value = 'downloading'
      downloadedBytes.value = progress.downloadedBytes
      totalBytes.value = progress.totalBytes
      retryNotice.value = progress.retry
        ? `Connexion interrompue, nouvelle tentative ${progress.retry.attempt}/${progress.retry.maxAttempts} pour ${progress.retry.file}...`
        : ''
    }
  })
})

onUnmounted(() => {
  removeProgressListener?.()
})
</script>

<style scoped>
.onboarding {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
  padding: 2rem;
}
.onboarding::before {
  content: '';
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 60% 50% at 50% 30%, rgba(200,155,60,.09) 0%, transparent 70%),
    radial-gradient(ellipse 40% 40% at 80% 80%, rgba(159,111,255,.05) 0%, transparent 60%),
    var(--bg-void);
}
.onboarding-card {
  position: relative;
  z-index: 1;
  max-width: 480px;
  text-align: center;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 2.5rem 2rem;
  box-shadow: 0 20px 60px rgba(0,0,0,.5);
  animation: card-rise .35s ease;
}
@keyframes card-rise {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.ob-icon {
  display: block;
  font-size: 2rem;
  margin-bottom: .5rem;
  filter: drop-shadow(0 0 12px var(--gold-glow));
}
.ob-title {
  font-family: var(--font-display);
  font-size: 1.2rem;
  font-weight: 700;
  color: var(--gold);
  margin: 0 0 .75rem;
  line-height: 1.4;
}
.ob-sub { color: var(--text-muted); font-size: .85rem; margin: 0 0 1.5rem; }
.ob-sub.error { color: #cc6d6d; }
.ob-sub.retry-notice { color: #d9a441; margin-top: -1rem; margin-bottom: 1rem; font-size: .78rem; }

.ob-actions { display: flex; flex-direction: column; gap: .65rem; }
.ob-actions .btn { width: 100%; }
.ob-actions .btn-outline { color: var(--text-muted); }
.ob-actions .btn-outline:hover { color: var(--gold-light); }

.ob-spinner { display: flex; justify-content: center; padding: 1rem 0; }
.spinner {
  width: 32px; height: 32px; border: 2px solid var(--border);
  border-top-color: var(--gold); border-radius: 50%;
  animation: spin .7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.progress-track {
  width: 100%; height: 8px; background: rgba(0,0,0,.35);
  border: 1px solid var(--border); border-radius: 999px; overflow: hidden;
}
.progress-fill {
  height: 100%; background: linear-gradient(90deg, #b8861e, var(--gold));
  box-shadow: 0 0 6px var(--gold-glow); transition: width .2s ease;
}
</style>
