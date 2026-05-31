<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import * as THREE from 'three'

const props = defineProps<{
  azimuth: number   // degrees, 0=front, 90=left
  elevation: number // degrees, 0=horizontal
  distance?: number // meters, default 1
  guessAzimuth?: number   // degrees — shows a guess marker when defined
  guessElevation?: number
  interactive?: boolean
  bgColor?: string  // CSS hex color, e.g. '#e8e8e8'
}>()

const emit = defineEmits<{
  change: [az: number, el: number]
}>()

const canvasRef = ref<HTMLCanvasElement>()

let renderer: THREE.WebGLRenderer
let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let speakerMesh: THREE.Group
let targetMarker: THREE.Mesh | null = null
let guessMarker: THREE.Mesh | null = null
let headMaterials: THREE.MeshStandardMaterial[] = []
let animId: number
let dragging = false
let lastX = 0
let lastY = 0
let localAz = props.azimuth
let localEl = props.elevation

const SPHERE_R = 1.55  // reference orbit radius (at distance = 1 m)

function azElToPos(azDeg: number, elDeg: number, r: number) {
  const az = (azDeg * Math.PI) / 180
  const el = (elDeg * Math.PI) / 180
  // same convention as HRTFEngine: az=0 front (-Z), az=90 left (-X)
  return new THREE.Vector3(
    -Math.sin(az) * Math.cos(el) * r,
    Math.sin(el) * r,
    -Math.cos(az) * Math.cos(el) * r,
  )
}

function buildHead(scene: THREE.Scene) {
  const mat = new THREE.MeshStandardMaterial({ color: 0x4a5568, roughness: 0.6, metalness: 0.1 })
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2d3748, roughness: 0.8 })
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x1a202c })
  headMaterials = [mat, darkMat, eyeMat]

  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.5, 48, 48), mat)
  scene.add(head)

  // Ears
  const earGeo = new THREE.SphereGeometry(0.09, 16, 16)
  earGeo.scale(0.55, 1, 0.3)
  const leftEar = new THREE.Mesh(earGeo, mat)
  leftEar.position.set(-0.52, 0, 0)
  scene.add(leftEar)
  const rightEar = new THREE.Mesh(earGeo.clone(), mat)
  rightEar.position.set(0.52, 0, 0)
  scene.add(rightEar)

  // Neck
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 0.28, 24), mat)
  neck.position.set(0, -0.64, 0)
  scene.add(neck)

  // Eyes (directional indicator)
  const eyeGeo = new THREE.SphereGeometry(0.06, 12, 12)
  ;[-0.17, 0.17].forEach((x) => {
    const eye = new THREE.Mesh(eyeGeo, eyeMat)
    eye.position.set(x, 0.06, -0.46)
    scene.add(eye)
  })

  // Nose
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.12, 12), darkMat)
  nose.rotation.x = Math.PI / 2
  nose.position.set(0, -0.08, -0.5)
  scene.add(nose)
}

function setHeadOpacity(opacity: number) {
  for (const mat of headMaterials) {
    mat.transparent = opacity < 1
    mat.opacity = opacity
    mat.depthWrite = opacity >= 1
    mat.needsUpdate = true
  }
}

function buildSpeaker(): THREE.Group {
  const g = new THREE.Group()

  // Speaker body (cylinder)
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.06, 0.18, 20),
    new THREE.MeshStandardMaterial({ color: 0x1a202c, roughness: 0.4, metalness: 0.6 }),
  )
  body.rotation.x = Math.PI / 2  // point along Z (toward head)
  g.add(body)

  // Cone/speaker grille
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.06, 0.1, 20),
    new THREE.MeshStandardMaterial({ color: 0x2d3748, roughness: 0.7 }),
  )
  cone.rotation.x = Math.PI / 2
  cone.position.z = 0.14
  g.add(cone)

  // Ring
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.08, 0.012, 8, 24),
    new THREE.MeshStandardMaterial({ color: 0x4a5568, metalness: 0.8, roughness: 0.3 }),
  )
  ring.rotation.x = Math.PI / 2
  g.add(ring)

  return g
}

function positionSpeaker(az: number, el: number) {
  if (!speakerMesh) return
  const d = Math.max(0.2, Math.min(6, props.distance ?? 1))
  const r = SPHERE_R * d
  const pos = azElToPos(az, el, r)
  speakerMesh.position.copy(pos)
  speakerMesh.lookAt(0, 0, 0)
  const s = Math.max(0.4, Math.min(2, 1 / Math.sqrt(d)))
  speakerMesh.scale.setScalar(s)
  // In reveal mode (guess visible), hide speaker so the target marker shows clearly
  speakerMesh.visible = props.guessAzimuth === undefined
  if (targetMarker) {
    targetMarker.position.copy(azElToPos(az, el, SPHERE_R))
    targetMarker.visible = props.guessAzimuth !== undefined
  }
}

function positionGuessMarker(az: number, el: number) {
  if (!guessMarker) return
  guessMarker.position.copy(azElToPos(az, el, SPHERE_R))
  guessMarker.visible = true
}

function init() {
  const canvas = canvasRef.value!
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  updateSize()

  scene = new THREE.Scene()
  const bgHex = props.bgColor ?? '#e8e8e8'
  scene.background = new THREE.Color(bgHex)

  camera = new THREE.PerspectiveCamera(52, canvas.clientWidth / canvas.clientHeight, 0.1, 100)
  camera.position.set(0, 0.4, 4)
  camera.lookAt(0, 0, 0)

  // Lighting
  scene.add(new THREE.AmbientLight(0xffffff, 0.55))
  const sun = new THREE.DirectionalLight(0xffffff, 1.2)
  sun.position.set(3, 5, 4)
  sun.castShadow = true
  scene.add(sun)
  const fill = new THREE.DirectionalLight(0xaabbff, 0.35)
  fill.position.set(-3, -1, -2)
  scene.add(fill)

  buildHead(scene)
  setHeadOpacity(props.guessAzimuth !== undefined ? 0.35 : 1)
  speakerMesh = buildSpeaker()
  scene.add(speakerMesh)

  targetMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 16, 16),
    new THREE.MeshStandardMaterial({ color: 0x27ae60, emissive: 0x1a7a42, emissiveIntensity: 0.4, roughness: 0.4 }),
  )
  targetMarker.visible = false
  scene.add(targetMarker)

  guessMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 16, 16),
    new THREE.MeshStandardMaterial({ color: 0x5c6bc0, emissive: 0x3d4fa0, emissiveIntensity: 0.4, roughness: 0.4 }),
  )
  guessMarker.visible = false
  scene.add(guessMarker)

  positionSpeaker(localAz, localEl)
  if (props.guessAzimuth !== undefined && props.guessElevation !== undefined) {
    positionGuessMarker(props.guessAzimuth, props.guessElevation)
  }

  // Faint orbit sphere wireframe
  const wires = new THREE.Mesh(
    new THREE.SphereGeometry(SPHERE_R, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0xcccccc, wireframe: true, transparent: true, opacity: 0.18 }),
  )
  scene.add(wires)

  animate()
}

function animate() {
  animId = requestAnimationFrame(animate)
  renderer.render(scene, camera)
}

function updateSize() {
  if (!canvasRef.value || !renderer) return
  const w = canvasRef.value.clientWidth
  const h = canvasRef.value.clientHeight
  renderer.setSize(w, h, false)
  if (camera) camera.aspect = w / h, camera.updateProjectionMatrix()
}

// --- interaction ---

function onPointerDown(e: PointerEvent) {
  if (!props.interactive) return
  dragging = true
  lastX = e.clientX
  lastY = e.clientY
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent) {
  if (!dragging || !props.interactive) return
  const dx = e.clientX - lastX
  const dy = e.clientY - lastY
  lastX = e.clientX
  lastY = e.clientY

  localAz = (localAz - dx * 0.55 + 360) % 360
  localEl = Math.max(-85, Math.min(85, localEl + dy * 0.35))

  positionSpeaker(localAz, localEl)
  emit('change', localAz, localEl)
}

function onPointerUp(e: PointerEvent) {
  dragging = false
  ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
}

// Sync external az/el/distance/guess when not in interactive drag
watch(
  () => [props.azimuth, props.elevation, props.distance, props.guessAzimuth, props.guessElevation] as
    [number, number, number | undefined, number | undefined, number | undefined],
  ([az, el, , guessAz, guessEl]) => {
    if (!dragging) {
      localAz = az
      localEl = el
      positionSpeaker(az, el)
    }
    setHeadOpacity(guessAz !== undefined ? 0.35 : 1)
    if (guessAz !== undefined && guessEl !== undefined) {
      positionGuessMarker(guessAz, guessEl)
    } else {
      if (guessMarker) guessMarker.visible = false
      if (targetMarker) targetMarker.visible = false
    }
  },
)

onMounted(() => {
  init()
  window.addEventListener('resize', updateSize)
})

onUnmounted(() => {
  cancelAnimationFrame(animId)
  renderer?.dispose()
  window.removeEventListener('resize', updateSize)
})
</script>

<template>
  <canvas
    ref="canvasRef"
    class="head-scene"
    :style="{ cursor: interactive ? 'grab' : 'default' }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
  />
</template>

<style scoped>
.head-scene {
  width: 100%;
  height: 100%;
  display: block;
  touch-action: none;
  position: relative;
  z-index: 0;
}
</style>
