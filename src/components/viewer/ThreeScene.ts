// ThreeScene.ts — pure TypeScript wrapper around a Three.js scene.
// Lifecycle is owned by osc-viewer-panel (custom element host).

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CameraState } from '../../state/app-state.ts';

export type { CameraState };

const BACKGROUND_COLOR = new THREE.Color(0x1e1e1e);

export interface NamedPosition {
  name: string;
  position: [number, number, number];
  target: [number, number, number];
}

// Named positions follow OpenSCAD's Z-up convention (camera.up = Z):
//   X = right, Y = depth (camera sits at -Y to view the "front"), Z = up
export const NAMED_POSITIONS: NamedPosition[] = [
  { name: 'Diagonal', position: [100, -100, 100], target: [0, 0, 0] },
  { name: 'Front', position: [0, -100, 0], target: [0, 0, 0] },
  { name: 'Right', position: [100, 0, 0], target: [0, 0, 0] },
  { name: 'Back', position: [0, 100, 0], target: [0, 0, 0] },
  { name: 'Left', position: [-100, 0, 0], target: [0, 0, 0] },
  { name: 'Top', position: [0, 0, 100], target: [0, 0, 0] },
  { name: 'Bottom', position: [0, 0, -100], target: [0, 0, 0] },
];

export class ThreeScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly scene: THREE.Scene;
  readonly controls: OrbitControls;
  private animationId: number | null = null;
  private modelMesh: THREE.Mesh | null = null;
  private axesObject: THREE.LineSegments | null = null;

  // Callback fired (debounced) when the user moves the camera.
  onCameraChange: ((state: CameraState) => void) | null = null;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      45,
      container.clientWidth / container.clientHeight,
      0.01,
      100_000,
    );
    const diag = NAMED_POSITIONS[0];
    this.camera.position.set(...diag.position);
    // OpenSCAD uses Z-up; tell Three.js so OrbitControls orbits correctly.
    this.camera.up.set(0, 0, 1);

    this.scene = new THREE.Scene();
    this.scene.background = BACKGROUND_COLOR;

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    const directional = new THREE.DirectionalLight(0xffffff, 0.9);
    directional.position.set(1, 2, 3).normalize();
    const back = new THREE.DirectionalLight(0xffffff, 0.3);
    back.position.set(-1, -1, -1).normalize();
    this.scene.add(ambient, directional, back);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;

    // Forward camera changes to caller (debounced 200 ms).
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    this.controls.addEventListener('change', () => {
      if (!this.onCameraChange) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        this.onCameraChange?.(this.getCameraState());
        debounceTimer = null;
      }, 200);
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    const animate = () => {
      this.animationId = requestAnimationFrame(animate);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  stop(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  resize(width: number, height: number): void {
    if (width === 0 || height === 0) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  dispose(): void {
    this.stop();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---------------------------------------------------------------------------
  // Geometry
  // ---------------------------------------------------------------------------

  loadGeometry(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation): void {
    // Remove previous mesh.
    if (this.modelMesh) {
      this.scene.remove(this.modelMesh);
      this.modelMesh.geometry.dispose();
      (this.modelMesh.material as THREE.Material).dispose();
      this.modelMesh = null;
    }

    // Use per-vertex colors when the OFF loader generated them (multi-material model).
    const hasVertexColors = geometry.hasAttribute('color');
    const material = new THREE.MeshPhongMaterial({
      color: hasVertexColors ? 0xffffff : color,
      vertexColors: hasVertexColors,
      side: THREE.DoubleSide,
      shininess: 40,
      specular: new THREE.Color(0x222222),
    });
    this.modelMesh = new THREE.Mesh(geometry, material);
    this.scene.add(this.modelMesh);
    this.fitCameraToMesh(this.modelMesh);
  }

  private fitCameraToMesh(mesh: THREE.Mesh): void {
    const box = new THREE.Box3().setFromObject(mesh);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim === 0) return;

    const fov = this.camera.fov * (Math.PI / 180);
    const dist = (maxDim / 2 / Math.tan(fov / 2)) * 2;

    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.controls.update();
  }

  // ---------------------------------------------------------------------------
  // Camera
  // ---------------------------------------------------------------------------

  getCameraState(): CameraState {
    return {
      position: this.camera.position.toArray() as [number, number, number],
      target: this.controls.target.toArray() as [number, number, number],
      zoom: this.camera.zoom,
    };
  }

  applyCameraState(saved: CameraState): void {
    this.camera.position.set(...saved.position);
    this.controls.target.set(...saved.target);
    this.camera.zoom = saved.zoom;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  setCameraPosition(name: string): void {
    const entry = NAMED_POSITIONS.find((p) => p.name === name) ?? NAMED_POSITIONS[0];
    // Scale the stored unit-sphere position to current fit distance.
    const box = this.modelMesh ? new THREE.Box3().setFromObject(this.modelMesh) : null;
    const center = box?.getCenter(new THREE.Vector3()) ?? new THREE.Vector3();
    const rad = box ? box.getSize(new THREE.Vector3()).length() / 2 : 100;

    const dir = new THREE.Vector3(...entry.position).normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, rad * 2.5);
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  // ---------------------------------------------------------------------------
  // Axes
  // ---------------------------------------------------------------------------

  private buildAxes(length = 50): THREE.LineSegments {
    const points = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(length, 0, 0),
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, length, 0),
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, length),
    ];
    const colors = [
      1,
      0,
      0,
      1,
      0,
      0, // X red
      0,
      1,
      0,
      0,
      1,
      0, // Y green
      0,
      0,
      1,
      0,
      0,
      1, // Z blue
    ];
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.LineBasicMaterial({ vertexColors: true });
    return new THREE.LineSegments(geometry, material);
  }

  setAxesVisible(visible: boolean): void {
    if (visible) {
      if (!this.axesObject) {
        this.axesObject = this.buildAxes();
      }
      if (!this.scene.children.includes(this.axesObject)) {
        this.scene.add(this.axesObject);
      }
    } else if (this.axesObject) {
      this.scene.remove(this.axesObject);
    }
  }

  // ---------------------------------------------------------------------------
  // Color
  // ---------------------------------------------------------------------------

  setModelColor(color: THREE.ColorRepresentation): void {
    if (this.modelMesh) {
      const mat = this.modelMesh.material as THREE.MeshPhongMaterial;
      // Don't override per-vertex colors from a multi-material model.
      if (!mat.vertexColors) mat.color.set(color);
    }
  }
}
