// Telemetry and exports remain in radians; only presentation uses the selected unit.
export function angleValue(value, unit='degree') {
  return Number.isFinite(value) ? (unit==='rad' ? value : value*180/Math.PI) : null;
}
export function angleText(value, unit='degree', detail=false) {
  const number=angleValue(value,unit);
  if (number===null) return '—';
  return number.toFixed(unit==='rad'?(detail?4:3):(detail?2:1))+(unit==='rad'?' rad':'°');
}
