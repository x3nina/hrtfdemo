<script setup lang="ts">
import { useRouter } from 'vue-router'

const router = useRouter()
</script>

<template>
  <div class="home">
    <header class="home__header">
      <h1 class="home__title">HRTF Demo</h1>
      <p class="home__sub">Head-Related Transfer Function spatial audio</p>
    </header>

    <div class="home__cards">
      <button class="card card--play" @click="router.push('/play')">
        <div class="card__icon">▶</div>
        <div class="card__label">Play</div>
        <div class="card__desc">
          A sound plays from a random position in 3D space. Rotate your head to find it.
        </div>
      </button>

      <button class="card card--test" @click="router.push('/test')">
        <div class="card__icon">◎</div>
        <div class="card__label">Test</div>
        <div class="card__desc">
          Drag a speaker around your head to explore different HRTF positions and profiles.
        </div>
      </button>
    </div>

    <footer class="home__footer">
      Use headphones for best results.
    </footer>
  </div>
</template>

<style scoped>
.home {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3rem;
  padding: 2rem;
  background: #0f0f14;
  color: #e0e0e0;
}

.home__header {
  text-align: center;
}

.home__title {
  font-size: 3rem;
  font-weight: 200;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: #fff;
  margin: 0;
}

.home__sub {
  margin: 0.5rem 0 0;
  font-size: 0.85rem;
  letter-spacing: 0.12em;
  color: #888;
  text-transform: uppercase;
}

.home__cards {
  display: flex;
  gap: 2rem;
  flex-wrap: wrap;
  justify-content: center;
}

.card {
  width: 240px;
  padding: 2.5rem 2rem;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  cursor: pointer;
  text-align: left;
  color: inherit;
  font-family: inherit;
  transition: border-color 0.2s, background 0.2s, transform 0.15s;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.card:hover {
  background: rgba(255, 255, 255, 0.07);
  transform: translateY(-3px);
}

.card--play:hover { border-color: #6c8cff; }
.card--test:hover { border-color: #c678dd; }

.card__icon {
  font-size: 1.8rem;
  opacity: 0.7;
}

.card--play .card__icon { color: #6c8cff; }
.card--test .card__icon { color: #c678dd; }

.card__label {
  font-size: 1.5rem;
  font-weight: 300;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.card__desc {
  font-size: 0.82rem;
  color: #888;
  line-height: 1.6;
}

.home__footer {
  font-size: 0.78rem;
  color: #555;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
</style>
