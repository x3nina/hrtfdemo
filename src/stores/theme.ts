import { ref } from 'vue'
import { defineStore } from 'pinia'

export type Theme = 'dark' | 'light'

export const useThemeStore = defineStore('theme', () => {
  const saved = localStorage.getItem('hrtf-theme') as Theme | null
  const theme = ref<Theme>(saved ?? 'dark')

  function apply(t: Theme) {
    document.documentElement.setAttribute('data-theme', t)
    localStorage.setItem('hrtf-theme', t)
    theme.value = t
  }

  function toggle() {
    apply(theme.value === 'dark' ? 'light' : 'dark')
  }
  apply(theme.value)

  return { theme, toggle }
})
