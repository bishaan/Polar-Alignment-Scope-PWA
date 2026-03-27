// PWA Registration
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('SW registered!', reg))
            .catch(err => console.log('SW registration failed', err));
    });
}

// Elements
const btnStart = document.getElementById('btn-start');
const overlay = document.getElementById('permission-overlay');
const appContainer = document.getElementById('app-container');

// State
let currentLocation = { lat: 33.42, lng: -111.92 }; // Default: Tempe, AZ
let currentOrientation = { pitch: 0, yaw: 0 };
let targetOrientation = { pitch: 33.42, yaw: 0 }; // Default defaults
let smoothedPitch = 0;
let smoothedYaw = 0;
let isAbsolute = false;
let firstFrame = true;
const PITCH_SMOOTHING = 0.1;
const YAW_SMOOTHING = 0.015;

function smoothAngle(current, target, alpha) {
    let diff = target - current;
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    let stepped = current + diff * alpha;
    while (stepped >= 360) stepped -= 360;
    while (stepped < 0) stepped += 360;
    return stepped;
}

// Declination logic (approx offset to True North based roughly on coords)
function estimateDeclination(lat, lng) {
    // Very rough approximation for US/AZ:
    // This is just a placeholder - full WMM is heavy.
    // We default to adding 10.5 for Arizona (since magnetic is 10.5 East of True).
    // Let's use 10.5 for now as user requested Tempe AZ fallback.
    return 10.5; 
}

// Astronomy Math
function getPolarisOffset(lat, lng) {
    const now = new Date();
    
    // Calculate Julian Days
    const julianDate = (now.getTime() / 86400000) + 2440587.5;
    
    // Calculate GMST (Greenwich Mean Sidereal Time)
    const T = (julianDate - 2451545.0) / 36525;
    let gmst = 280.46061837 + 360.98564736629 * (julianDate - 2451545.0) + T * T * 0.000387933 - T * T * T / 38710000;
    gmst = gmst % 360;
    if (gmst < 0) gmst += 360;

    // LST (Local Sidereal Time) in degrees
    let lst = (gmst + lng) % 360;
    if (lst < 0) lst += 360;

    // Polaris RA and Dec (Epoch J2025/J2026 - Very important due to rapid precession!)
    // RA roughly 3h 05m = 46.25 degrees
    // Dec roughly +89deg 22m 22s = 89.37 degrees
    const polarisRA = 46.25;
    const polarisDec = 89.37;

    // Hour Angle
    let ha = lst - polarisRA;
    const haRad = ha * (Math.PI / 180);

    // Offset is roughly 0.63 degrees from True North pole currently!
    const offsetMag = 90 - polarisDec; 
    
    // Altitude Offsets (Pitch)
    // HA=0: Polaris is directly ABOVE the pole (+ pitch).
    const pitchOffset = Math.cos(haRad) * offsetMag;

    // Azimuth Offsets (Yaw)
    // HA > 0 means Polaris has crossed the meridian and is WEST of the pole (negative azimuth offset).
    // scaled by sec(lat) for projection mapping onto the horizon.
    const yawOffset = -Math.sin(haRad) * offsetMag / Math.cos(lat * Math.PI / 180);

    return { pitchOffset, yawOffset };
}

// Screen Wake Lock
let wakeLock = null;
async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
        } catch (err) {
            console.warn(`Wake Lock error: ${err.message}`);
        }
    }
}
document.addEventListener('visibilitychange', () => {
    if (wakeLock !== null && document.visibilityState === 'visible') {
        requestWakeLock();
    }
});

// initialization
btnStart.addEventListener('click', async () => {
    requestWakeLock();

    // Request orientation permission on iOS
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        try {
            const permission = await DeviceOrientationEvent.requestPermission();
            if (permission !== 'granted') {
                alert('Orientation permission denied! The app will not function correctly.');
                return;
            }
        } catch (e) {
            console.error(e);
        }
    }

    // Hide overlay, show app
    overlay.classList.remove('active');
    overlay.classList.add('hidden');
    appContainer.classList.remove('hidden');

    initSensors();
    requestAnimationFrame(updateUI);
});


function initSensors() {
    // GPS
    if (navigator.geolocation) {
        navigator.geolocation.watchPosition(pos => {
            currentLocation.lat = pos.coords.latitude;
            currentLocation.lng = pos.coords.longitude;
            document.getElementById('val-gps').textContent = 
                `${currentLocation.lat.toFixed(3)}, ${currentLocation.lng.toFixed(3)}`;
        }, err => console.warn('GPS Error:', err), { enableHighAccuracy: true });
    }

    // Compass / Orientation Tracker
    // Attach both absolute and fallback. Absolute will flag itself if it works.
    window.addEventListener('deviceorientationabsolute', handleOrientationAbsolute, true);
    window.addEventListener('deviceorientation', handleOrientationFallback, true);
}

function handleOrientationAbsolute(event) {
    if (event.alpha !== null) {
        isAbsolute = true;
        currentOrientation.pitch = event.beta;
        currentOrientation.yaw = (360 - event.alpha) % 360;
    }
}

function handleOrientationFallback(event) {
    if (isAbsolute && event.webkitCompassTrueHeading === undefined && event.webkitCompassHeading === undefined) return; 
    
    currentOrientation.pitch = event.beta;
    
    if (event.webkitCompassTrueHeading !== undefined && event.webkitCompassTrueHeading !== -1 && event.webkitCompassTrueHeading !== null) {
        // iOS provides TRUE heading directly if GPS/Location Services is enabled!
        isAbsolute = true;
        currentOrientation.yaw = event.webkitCompassTrueHeading % 360;
    } else if (event.webkitCompassHeading !== undefined) {
        // Fallback to Magnetic North + WMM estimation if True Heading fails
        isAbsolute = true;
        let declination = estimateDeclination(currentLocation.lat, currentLocation.lng);
        currentOrientation.yaw = (event.webkitCompassHeading + declination) % 360;
    } else if (event.alpha !== null) {
        if (event.absolute) isAbsolute = true;
        currentOrientation.yaw = (360 - event.alpha) % 360;
    }
}

function updateUI() {
    // Update Targets
    const polaris = getPolarisOffset(currentLocation.lat, currentLocation.lng);
    
    // Target base points to True North, tilted up to latitude
    targetOrientation.pitch = currentLocation.lat + polaris.pitchOffset;
    
    // True North Azimuth is 0, adding offset
    targetOrientation.yaw = (360 + polaris.yawOffset) % 360;

    // Smoothing Filter
    if (firstFrame && currentOrientation.yaw !== undefined) {
        smoothedPitch = currentOrientation.pitch || 0;
        smoothedYaw = currentOrientation.yaw || 0;
        firstFrame = false;
    } else if (!firstFrame) {
        smoothedPitch = smoothedPitch + (currentOrientation.pitch - smoothedPitch) * PITCH_SMOOTHING;
        smoothedYaw = smoothAngle(smoothedYaw, currentOrientation.yaw, YAW_SMOOTHING);
    }

    // Update readouts 
    document.getElementById('val-pitch-target').textContent = targetOrientation.pitch.toFixed(1);
    document.getElementById('val-pitch-current').textContent = smoothedPitch.toFixed(1);
    
    document.getElementById('val-az-target').textContent = targetOrientation.yaw.toFixed(1);
    document.getElementById('val-az-current').textContent = smoothedYaw.toFixed(1) + (isAbsolute ? '' : ' (Rel)');

    // Reticle Mapping
    // 1 Degree Difference = 30 Pixels (Sensitivity)
    const pxPerDegree = 30;
    
    let yawDiff = smoothedYaw - targetOrientation.yaw;
    // Handle wrap around 360
    if (yawDiff > 180) yawDiff -= 360;
    if (yawDiff < -180) yawDiff += 360;
    
    let pitchDiff = smoothedPitch - targetOrientation.pitch;

    const targetEl = document.getElementById('reticle-current');
    
    // If the device's Az is greater than target Az (yawDiff > 0), the device is pointing to the right of the target.
    // So the target appears to the LEFT of the center crosshair.
    // Since crosshair represents device, if device is to the right, crosshair physically moves right.
    targetEl.style.left = `calc(50% + ${yawDiff * pxPerDegree}px)`;
    
    // If pitchDiff > 0, the device is pitched too high, so crosshair moves up.
    // But CSS top mapping: top: 0 is top of screen.
    // Negative pixels moves UP. So crosshair TOP is 50% - pitchDiff * px.
    targetEl.style.top = `calc(50% - ${pitchDiff * pxPerDegree}px)`;

    // Lock condition: within 0.5 degrees
    if (Math.abs(yawDiff) <= 0.5 && Math.abs(pitchDiff) <= 0.5) {
        targetEl.classList.add('aligned');
    } else {
        targetEl.classList.remove('aligned');
    }

    requestAnimationFrame(updateUI);
}
