<template>
  <div class="login-view">
    <div class="login-bg" />
    <div class="login-card">
      <div class="login-logo">
        <span class="logo-icon">⚔️</span>
        <h1 class="logo-title glow-gold">KRASHLAND</h1>
        <p class="logo-sub">WoW 3.3.5 — Launcher officiel</p>
      </div>

      <form class="login-form" @submit.prevent="submit">
        <label class="field">
          <span>Identifiant</span>
          <input v-model="username" type="text" autocomplete="username" placeholder="Ton pseudo" />
        </label>
        <label class="field">
          <span>Mot de passe</span>
          <input v-model="password" type="password" autocomplete="current-password" placeholder="••••••••" />
        </label>

        <p v-if="error" class="login-error">{{ error }}</p>

        <button type="submit" class="btn btn-gold btn-login" :disabled="loading || !username || !password">
          {{ loading ? 'Connexion...' : 'Se connecter' }}
        </button>
      </form>

      <p class="login-register">
        Pas encore de compte ?
        <a href="#" @click.prevent="openRegister">Créer un compte</a>
      </p>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'

const emit = defineEmits(['logged-in'])

const username = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)

async function submit() {
  error.value = ''
  loading.value = true
  try {
    const res = await window.krash.auth.login(username.value.trim(), password.value)
    if (res.ok) {
      emit('logged-in', res.user)
    } else {
      error.value = res.error || 'Connexion impossible'
    }
  } finally {
    loading.value = false
  }
}

function openRegister() {
  window.open('https://krashland.fr/register', '_blank')
}
</script>

<style scoped>
.login-view {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
}
.login-bg {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(ellipse 60% 50% at 50% 30%, rgba(200,155,60,.1) 0%, transparent 70%),
    radial-gradient(ellipse 40% 40% at 80% 80%, rgba(159,111,255,.06) 0%, transparent 60%),
    var(--bg-void);
}

.login-card {
  position: relative;
  z-index: 1;
  width: 360px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 2rem 2.25rem;
  box-shadow: 0 20px 60px rgba(0,0,0,.5), 0 0 40px rgba(200,155,60,.04);
  animation: card-rise .35s ease;
}
@keyframes card-rise {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.login-logo { text-align: center; margin-bottom: 1.75rem; }
.logo-icon { font-size: 1.9rem; filter: drop-shadow(0 0 12px var(--gold-glow)); }
.logo-title {
  font-family: var(--font-display);
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--gold);
  letter-spacing: .08em;
  margin: .35rem 0 .15rem;
}
.logo-sub { font-size: .72rem; color: var(--text-muted); }

.login-form { display: flex; flex-direction: column; gap: 1rem; }
.field { display: flex; flex-direction: column; gap: .35rem; font-size: .78rem; color: var(--text-muted); }
.field input {
  background: rgba(0,0,0,.3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: .55rem .75rem;
  color: var(--text);
  font-family: var(--font-body);
  font-size: .85rem;
  outline: none;
  transition: border-color var(--transition), box-shadow var(--transition);
}
.field input:focus { border-color: var(--gold); box-shadow: 0 0 0 3px var(--gold-glow); }

.login-error {
  font-size: .78rem;
  color: #cc6d6d;
  background: rgba(204,109,109,.08);
  border: 1px solid rgba(204,109,109,.25);
  border-radius: var(--radius-sm);
  padding: .5rem .65rem;
}

.btn-login {
  margin-top: .25rem;
  width: 100%;
  font-size: .88rem;
  letter-spacing: .05em;
}

.login-register {
  margin-top: 1.25rem;
  text-align: center;
  font-size: .76rem;
  color: var(--text-muted);
}
.login-register a { color: var(--gold); cursor: pointer; }
.login-register a:hover { color: var(--gold-light); }
</style>
