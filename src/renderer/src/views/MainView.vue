<template>
  <OnboardingView v-if="gameStatus === 'onboarding'" @done="onOnboardingDone" />

  <div v-else class="main-view">

    <!-- SIDEBAR -->
    <aside class="sidebar">
      <div class="user-box">
        <span class="user-avatar">👤</span>
        <div class="user-info">
          <span class="user-name">{{ user?.username }}</span>
          <span class="user-gm" v-if="user?.gmLevel > 0">GM {{ user.gmLevel }}</span>
        </div>
      </div>

      <nav class="side-nav">
        <a class="side-link" :class="{ active: tab === 'news' }" @click="tab = 'news'">📰 Actualités</a>
        <a class="side-link" :class="{ active: tab === 'settings' }" @click="tab = 'settings'">⚙️ Options</a>
      </nav>

      <div class="side-links">
        <a class="ext-link" @click="openExternal(websiteUrl)">🌐 Site web</a>
        <a class="ext-link" @click="openExternal(discordUrl)">💬 Discord</a>
        <a class="ext-link" @click="openExternal(voteUrl)">🗳️ Voter</a>
        <a class="ext-link" @click="logout">↩ Déconnexion</a>
      </div>
    </aside>

    <!-- CONTENU -->
    <section class="content">

      <div v-if="tab === 'news'" class="news-tab">
        <h2 class="content-title glow-gold">Dernières nouvelles</h2>
        <div class="divider-ornament" />
        <div v-if="newsLoading" class="state-msg">Chargement...</div>
        <div v-else-if="newsError" class="state-msg state-error">Erreur de chargement : {{ newsError }}</div>
        <div v-else-if="!news.length" class="state-msg">Aucune actualité pour le moment.</div>
        <div v-else class="news-list">
          <article
            v-for="n in news"
            :key="n.id"
            class="news-item card"
            role="link"
            tabindex="0"
            @click="openExternal(`${websiteUrl}/news/${n.id}`)"
            @keydown.enter="openExternal(`${websiteUrl}/news/${n.id}`)"
          >
            <div class="news-item-head">
              <span class="cat-badge badge" :class="`cat-${n.category}`">{{ n.category }}</span>
              <span class="news-date">{{ formatDate(n.created_at) }}</span>
            </div>
            <h3>{{ n.title }}</h3>
            <p>{{ excerpt(n.content) }}</p>
            <span class="news-read-more">Lire sur le site →</span>
          </article>
        </div>
      </div>

      <div v-else-if="tab === 'settings'" class="settings-tab">
        <h2 class="content-title glow-gold">Options</h2>
        <div class="divider-ornament" />
        <label class="field">
          <span>Dossier d'installation du jeu</span>
          <div class="path-row">
            <input class="input" :value="installPath || 'Non défini'" readonly />
            <button class="btn btn-outline" @click="chooseFolder">Choisir...</button>
          </div>
        </label>
        <button v-if="installPath" class="btn btn-outline btn-recheck" @click="runSync">
          🔄 Vérifier à nouveau les fichiers
        </button>
      </div>

    </section>

    <!-- BARRE JOUER -->
    <footer class="play-bar">
      <div class="play-status-col">
        <div class="play-status">
          <span class="status-dot" :class="statusClass" />
          {{ statusLabel }}
        </div>
        <div v-if="gameStatus === 'downloading'" class="progress-track">
          <div class="progress-fill" :style="{ width: progressPercent + '%' }" />
        </div>
      </div>
      <button class="btn btn-gold btn-play" :disabled="playDisabled" @click="play">
        {{ playLabel }}
      </button>
    </footer>

  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import OnboardingView from './OnboardingView.vue'

const props = defineProps({ user: { type: Object, required: true } })
const emit = defineEmits(['logged-out'])

const tab = ref('news')
const news = ref([])
const newsLoading = ref(false)
const newsError = ref('')
const installPath = ref('')
const syncError = ref('')
// Résolue dynamiquement via IPC (config:get) — reflète KRASH_API_URL côté main
// process, donc reste cohérente avec le reste du launcher (auth, sync, play)
// même en test local (sinon le fetch news tapait toujours krashland.fr en prod).
const apiBaseUrl = ref('')

// État du jeu : onboarding | no-path | checking | downloading | ready | launching |
// waiting-window | typing-credentials | needs-relogin | error
const gameStatus = ref('onboarding')
const downloadedBytes = ref(0)
const totalBytes = ref(0)
const checkedCount = ref(0)
const checkedTotal = ref(0)
// Mémorise l'état "prêt" précédent pour pouvoir y revenir après un lancement (réussi ou pas)
let lastReadyStatus = 'ready'

let removeProgressListener = null
let removePlayStatusListener = null

// Résolus dynamiquement via config:get (même appel IPC que apiBaseUrl)
const websiteUrl = ref('')
const discordUrl = ref('')
const voteUrl = ref('')

const progressPercent = computed(() => {
  if (!totalBytes.value) return 0
  return Math.min(100, Math.round((downloadedBytes.value / totalBytes.value) * 100))
})

const statusClass = computed(() => ({
  'dot-green': gameStatus.value === 'ready',
  'dot-gold': ['downloading', 'checking', 'launching', 'waiting-window', 'typing-credentials'].includes(gameStatus.value),
  'dot-red': ['error', 'no-path', 'needs-relogin'].includes(gameStatus.value)
}))
const statusLabel = computed(() => {
  if (gameStatus.value === 'checking' && checkedTotal.value) {
    return `Vérification (${checkedCount.value}/${checkedTotal.value})...`
  }
  if (gameStatus.value === 'downloading') {
    const mb = (downloadedBytes.value / 1024 / 1024).toFixed(0)
    const totalMb = (totalBytes.value / 1024 / 1024).toFixed(0)
    return `Téléchargement... ${mb} / ${totalMb} Mo (${progressPercent.value}%)`
  }
  return {
    'no-path': "Choisis un dossier d'installation dans Options",
    checking: 'Vérification des fichiers...',
    ready: 'Prêt à jouer',
    launching: 'Lancement du jeu...',
    'waiting-window': "En attente de l'écran de connexion...",
    'typing-credentials': 'Connexion automatique...',
    'needs-relogin': 'Reconnecte-toi pour activer la connexion auto au jeu',
    error: syncError.value || 'Erreur de synchronisation'
  }[gameStatus.value] || ''
})
const playDisabled = computed(() =>
  !['ready', 'needs-relogin'].includes(gameStatus.value)
)
const playLabel = computed(() => {
  if (['ready'].includes(gameStatus.value)) return 'JOUER'
  if (gameStatus.value === 'needs-relogin') return 'JOUER (sans auto-login)'
  return '...'
})

function openExternal(url) { window.open(url, '_blank') }

async function logout() {
  await window.krash.auth.logout()
  emit('logged-out')
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })
}
function excerpt(content) {
  const plain = content.replace(/[#*>`_-]/g, '').trim()
  return plain.length > 140 ? plain.slice(0, 140) + '…' : plain
}

async function chooseFolder() {
  const res = await window.krash.game.chooseFolder()
  if (res.ok) {
    installPath.value = res.path
    runSync()
  }
}

// Check complet (potentiellement des centaines/milliers de fichiers) — appelé
// uniquement depuis l'onboarding ou via le bouton "Vérifier les fichiers" dans
// Options, jamais automatiquement à chaque ouverture du launcher (trop lent pour
// les joueurs avec un disque/PC modeste : on fait confiance à l'état déjà vérifié).
async function runSync() {
  if (!installPath.value) {
    gameStatus.value = 'no-path'
    return
  }
  syncError.value = ''
  gameStatus.value = 'checking'
  downloadedBytes.value = 0
  totalBytes.value = 0

  const res = await window.krash.game.sync()
  if (res.ok) {
    gameStatus.value = 'ready'
  } else {
    gameStatus.value = 'error'
    syncError.value = res.error || 'Erreur inconnue'
  }
}

function onOnboardingDone() {
  gameStatus.value = 'ready'
}

async function play() {
  if (gameStatus.value === 'ready') lastReadyStatus = 'ready'
  syncError.value = ''
  gameStatus.value = 'launching'

  const res = await window.krash.game.play()

  if (res.ok) {
    gameStatus.value = lastReadyStatus
    return
  }

  if (res.code === 'NEEDS_RELOGIN') {
    gameStatus.value = 'needs-relogin'
    return
  }

  gameStatus.value = 'error'
  syncError.value = res.error || 'Erreur de lancement'
}

onMounted(async () => {
  const cfg = await window.krash.config.get()
  apiBaseUrl.value = cfg.apiBaseUrl
  websiteUrl.value = cfg.websiteUrl
  discordUrl.value = cfg.discordUrl
  voteUrl.value = cfg.voteUrl

  newsLoading.value = true
  try {
    // Endpoint public déjà existant côté site (admin_news)
    const res = await fetch(`${apiBaseUrl.value}/admin/news/public`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    news.value = await res.json()
  } catch (e) {
    console.error('[MainView] échec chargement news :', e)
    newsError.value = e.message || 'Erreur de chargement'
    news.value = []
  } finally {
    newsLoading.value = false
  }

  removeProgressListener = window.krash.game.onSyncProgress((progress) => {
    if (progress.phase === 'checking') {
      gameStatus.value = 'checking'
      checkedCount.value = progress.checked
      checkedTotal.value = progress.total
    } else if (progress.phase === 'downloading') {
      gameStatus.value = 'downloading'
      downloadedBytes.value = progress.downloadedBytes
      totalBytes.value = progress.totalBytes
    }
  })

  // Statuts détaillés pendant le clic JOUER (lancement → attente fenêtre → saisie)
  removePlayStatusListener = window.krash.game.onPlayStatus((status) => {
    if (['launching', 'waiting-window', 'typing-credentials'].includes(status)) {
      gameStatus.value = status
    }
  })

  installPath.value = await window.krash.store.get('game.installPath') || ''
  const installVerified = await window.krash.store.get('game.installVerified')

  if (installPath.value && installVerified) {
    // Déjà vérifié lors d'un lancement précédent : on saute le check complet,
    // zéro lecture disque, direct prêt à jouer.
    gameStatus.value = 'ready'
  } else {
    // Pas encore de dossier, ou dossier jamais vérifié avec succès : onboarding.
    gameStatus.value = 'onboarding'
  }
})

onUnmounted(() => {
  removeProgressListener?.()
  removePlayStatusListener?.()
})
</script>

<style scoped>
.main-view { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

/* Layout sidebar + content en grid sur le corps, footer pleine largeur en bas */
.main-view { display: grid; grid-template-rows: 1fr auto; grid-template-columns: 1fr; }
.main-view > .sidebar { grid-row: 1; }

.main-view {
  display: grid;
  grid-template-columns: 220px 1fr;
  grid-template-rows: 1fr auto;
}
.sidebar { grid-column: 1; grid-row: 1; }
.content { grid-column: 2; grid-row: 1; overflow-y: auto; }
.play-bar { grid-column: 1 / -1; grid-row: 2; }

.sidebar {
  background: linear-gradient(180deg, var(--bg-deep), var(--bg-void));
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 1rem .85rem;
}
.user-box {
  display: flex; align-items: center; gap: .6rem; padding: .6rem .7rem; margin-bottom: 1rem;
  background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius);
}
.user-avatar {
  font-size: 1.3rem; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center;
  border-radius: 50%; background: var(--gold-glow); border: 1px solid var(--border-bright);
}
.user-info { display: flex; flex-direction: column; }
.user-name { font-family: var(--font-display); font-size: .85rem; color: var(--text); font-weight: 600; }
.user-gm { font-size: .65rem; color: var(--arcane); }

.side-nav { display: flex; flex-direction: column; gap: .25rem; }
.side-link {
  padding: .55rem .7rem;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: .82rem;
  cursor: pointer;
  border-left: 2px solid transparent;
  transition: background var(--transition), color var(--transition), border-color var(--transition);
}
.side-link:hover { background: var(--bg-card-hover); color: var(--text); }
.side-link.active { background: var(--bg-card-hover); color: var(--gold); border-left-color: var(--gold); }

.side-links { margin-top: auto; display: flex; flex-direction: column; gap: .15rem; border-top: 1px solid var(--border); padding-top: .75rem; }
.ext-link { padding: .45rem .65rem; font-size: .76rem; color: var(--text-muted); cursor: pointer; transition: color var(--transition); }
.ext-link:hover { color: var(--gold-light); }

.content { padding: 1.5rem 1.75rem; }
.content-title { font-family: var(--font-display); font-size: 1.15rem; font-weight: 700; color: var(--gold); margin-bottom: .75rem; }
.content .divider-ornament { margin: 0 0 1.25rem; width: auto; }
.content .divider-ornament::before { width: 32px; }
.content .divider-ornament::after { display: none; }

.state-msg { color: var(--text-muted); font-size: .85rem; }
.state-error { color: #cc6d6d; }

.news-list { display: flex; flex-direction: column; gap: 1rem; }
.news-item { padding: 1rem 1.15rem; cursor: pointer; }
.news-item:hover { transform: translateY(-1px); border-color: var(--gold-dim, var(--border-bright)); }
.news-item:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--gold-glow); }
.news-item-head { display: flex; align-items: center; gap: .6rem; margin-bottom: .5rem; }
.cat-badge { font-size: .65rem; }
.news-date { font-size: .7rem; color: var(--text-dim); }
.news-item h3 { font-family: var(--font-display); font-size: .92rem; color: var(--text); margin-bottom: .4rem; }
.news-item p { font-size: .8rem; color: var(--text-muted); line-height: 1.6; }
.news-read-more {
  display: inline-block;
  margin-top: .6rem;
  font-size: .72rem;
  font-weight: 600;
  letter-spacing: .03em;
  color: var(--gold);
  opacity: 0;
  transform: translateX(-4px);
  transition: opacity var(--transition), transform var(--transition);
}
.news-item:hover .news-read-more,
.news-item:focus-visible .news-read-more { opacity: 1; transform: translateX(0); }

.field { display: flex; flex-direction: column; gap: .4rem; font-size: .8rem; color: var(--text-muted); }
.path-row { display: flex; gap: .5rem; }
.path-row .input { flex: 1; font-size: .8rem; }
.path-row .btn { font-size: .78rem; padding: .5rem .9rem; letter-spacing: 0; text-transform: none; }
.btn-recheck { margin-top: 1.25rem; font-size: .78rem; padding: .55rem 1rem; letter-spacing: 0; text-transform: none; }

.play-bar {
  background: linear-gradient(180deg, var(--bg-void), var(--bg-deep));
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: .85rem 1.5rem;
  gap: 1.5rem;
}
.play-status-col { display: flex; flex-direction: column; gap: .4rem; flex: 1; min-width: 0; }
.play-status { display: flex; align-items: center; gap: .5rem; font-size: .78rem; color: var(--text-muted); }
.status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.dot-green { background: #6dcc6d; box-shadow: 0 0 8px #6dcc6d; }
.dot-gold { background: var(--gold); box-shadow: 0 0 8px var(--gold-glow); animation: pulse-dot 1.4s ease-in-out infinite; }
.dot-red { background: #cc6d6d; box-shadow: 0 0 8px #cc6d6d; }
@keyframes pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }

.progress-track {
  width: 100%;
  max-width: 360px;
  height: 6px;
  background: rgba(0,0,0,.35);
  border: 1px solid var(--border);
  border-radius: 999px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #b8861e, var(--gold));
  box-shadow: 0 0 6px var(--gold-glow);
  transition: width .2s ease;
}

.btn-play {
  padding: .8rem 2.75rem;
  font-size: 1rem;
  letter-spacing: .06em;
}
.btn-play:disabled { box-shadow: none; }
</style>
