import * as THREE from 'three';
import { modelPose } from './view-pose.js?v=20261030-live-3d';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import URDFLoader from '/vendor/urdf-loader/src/URDFLoader.js';

export class Viewer {
  constructor(canvas) {
    this.dirty = true;
    this.scene = new THREE.Scene();
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    const gl=this.renderer.getContext(), debug=gl.getExtension('WEBGL_debug_renderer_info');
    this.software=!!debug && /swiftshader|llvmpipe|softpipe|software/i.test(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL));
    // Bound raster work on large/high-DPI windows, especially CPU-rendered WebGL.
    this.pixelBudget=this.software?350000:1000000;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = !this.software;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.01, 20);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.addEventListener('change', () => { this.dirty = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.dirty = true; });
    this.controls.enableDamping = true;
    this.controls.minDistance = 0.25;
    this.controls.maxDistance = 2;
    this.controls.maxPolarAngle = Math.PI * 0.9;
    this.reset();
    const ambient = new THREE.HemisphereLight(0xe5f0ff, 0x41434b, 1.6);
    ambient.position.set(0, 0, 1);
    this.scene.add(ambient);
    const light = new THREE.DirectionalLight(0xfff5e6, 2.2);
    light.position.set(0.5, -0.6, 0.9);
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    Object.assign(light.shadow.camera, {left:-0.3, right:0.3, top:0.3, bottom:-0.3, near:0.1, far:2});
    light.shadow.normalBias = 0.0004;
    light.shadow.bias = -0.0001;
    this.scene.add(light);
    const rim = new THREE.DirectionalLight(0xadcfff, 1.2);
    rim.position.set(-1, 1, 1);
    this.scene.add(rim);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShadowMaterial({opacity:0.23}));
    floor.position.z = -0.006;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.updateTheme();
    const axes = new THREE.AxesHelper(0.07);
    axes.position.set(-0.15, -0.15, 0);
    this.scene.add(axes);
    this.jointFrame = new THREE.Group();
    this.jointFrame.add(new THREE.AxesHelper(0.045));
    this.jointAxis = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(),
      0.075, 0xffd166, 0.014, 0.007);
    this.jointFrame.add(this.jointAxis);
    this.jointFrame.traverse(node => {
      if (node.material) {
        node.material.depthTest = false;
        node.material.depthWrite = false;
        node.renderOrder = 10;
      }
    });
    this.jointFrame.visible = false;
    this.scene.add(this.jointFrame);
    this.resize = new ResizeObserver(() => {
      const { width, height } = canvas.getBoundingClientRect();
      if(!width||!height)return;
      this.renderer.setPixelRatio(Math.min(devicePixelRatio,this.software?1:1.5,Math.sqrt(this.pixelBudget/(width*height))));
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.dirty = true;
    });
    this.resize.observe(canvas);
    this.lastRender = 0;
    const render = now => {
      requestAnimationFrame(render);
      if (document.hidden || now - this.lastRender < (this.software?67:32)) return;
      this.controls.update();
      if (!this.dirty) return;
      this.lastRender = now;
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
    };
    requestAnimationFrame(render);
  }
  updateTheme() {
    const dark = document.documentElement.dataset.theme === 'dark';
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      this.grid.material.dispose();
    }
    this.grid = new THREE.GridHelper(1.4, 28, dark ? 0x526875 : 0x9aaab4, dark ? 0x2d3b45 : 0xd0d9df);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.position.z = -0.005;
    this.scene.add(this.grid);
    this.dirty = true;
  }
  reset() {
    this.setView('home');
  }
  setView(view) {
    const positions = {home:[0.34, -0.42, 0.27], front:[0, -0.54, 0.13],
      side:[0.54, 0, 0.13], top:[0, 0, 0.67]};
    // Consume any remaining drag damping before setting an exact view.
    this.controls.enableDamping = false;
    this.controls.update();
    this.camera.up.set(0, view === 'top' ? 1 : 0, view === 'top' ? 0 : 1);
    this.camera.position.set(...positions[view]);
    this.controls.target.set(0, 0, 0.13);
    this.controls.update();
    this.controls.enableDamping = true;
  }
  async load() {
    const manager = new THREE.LoadingManager();
    const ready = new Promise((resolve, reject) => {
      manager.onLoad = resolve;
      manager.onError = url => reject(new Error(`模型资源加载失败：${url}`));
    });
    const loader = new URDFLoader(manager);
    this.robot = await loader.loadAsync('/models/alpha-full/robot.urdf');
    await ready;
    this.robot.traverse(node => {
      if (node.isMesh) {
        node.geometry.computeVertexNormals();
        node.material = new THREE.MeshStandardMaterial({color:node.material.color,
          roughness:0.7, metalness:0.06, side:THREE.DoubleSide});
        node.castShadow = true;
        node.receiveShadow = true;
        node.userData.originalColor = node.material.color.clone();
      }
    });
    for (const joint of Object.values(this.robot.joints)) joint.ignoreLimits = true;
    this.scene.add(this.robot);
    this.ghost = this.robot.clone();
    this.ghost.traverse(node => {
      node.castShadow = false;
      if (node.isMesh) node.material = new THREE.MeshBasicMaterial({ color: 0xcfae73,
        transparent: true, opacity: 0.18, depthWrite: false });
    });
    this.ghost.visible = false;
    this.scene.add(this.ghost);
    this.dirty = true;
  }
  update(state, selected, ghost, showAxes = false) {
    if (!this.robot || !this.ghost) return;
    const {attitude,feedback,targets}=modelPose(state);
    const [w,x,y,z]=attitude?.quat || [1,0,0,0];
    const poseKey = JSON.stringify([w,x,y,z,selected,ghost,showAxes,feedback,ghost?targets:null]);
    if (poseKey === this.poseKey) return;
    this.poseKey = poseKey;
    this.dirty = true;
    // Rotate about the trunk origin, keeping URDF root height and ground fixed.
    this.robot.links.body_0.quaternion.set(x,y,z,w);
    this.ghost.links.body_0.quaternion.set(x,y,z,w);
    // Live monitoring uses feedback; missing samples and historical snapshots use reference angles.
    this.robot.setJointValues(feedback);
    this.ghost.setJointValues(targets);
    this.ghost.visible = ghost && Object.keys(targets).length > 0;
    this.robot.traverse(node => {
      if (node.isMesh && node.userData.originalColor) node.material.color.copy(node.userData.originalColor);
    });
    const name = state.joints.find(j => j.id === selected)?.name;
    const selectedJoint = this.robot.joints[name];
    this.jointFrame.visible = showAxes && !!selectedJoint;
    if (this.jointFrame.visible) {
      // A scene sibling keeps inspection helpers out of both URDF trees.
      selectedJoint.updateWorldMatrix(true, false);
      selectedJoint.matrixWorld.decompose(this.jointFrame.position, this.jointFrame.quaternion,
        this.jointFrame.scale);
      this.jointAxis.setDirection(selectedJoint.axis);
    }
    const link = selectedJoint?.children[0];
    // Highlight this link's visuals, not every downstream joint.
    for (const child of link?.children || []) {
      if (child.isURDFJoint) continue;
      child.traverse(node => { if (node.isMesh) node.material.color.lerp(new THREE.Color(0x67dbbd), 0.4); });
    }
  }
}
