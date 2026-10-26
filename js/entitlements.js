// Entitlements - centralized checks
function getEntitlements(userId) {
  if (!userId) {
    const anonUsed = parseInt(localStorage.getItem('spim_images_anon_used') || '0', 10);
    return { images: { used: anonUsed, limit: 16, enabled: anonUsed < 16 }, parcels: { enabled: false }, text_spim: { enabled: true } };
  }
  const used = parseInt(localStorage.getItem('spim_images_used_'+userId) || '0', 10);
  const paid = localStorage.getItem('spim_paid_'+userId) === 'true';
  const imagesEnabled = used < 16 || paid;
  const parcelsEnabled = paid;
  return {
    text_spim: { enabled: true },
    images: { enabled: imagesEnabled, used, limit: 16, paid },
    parcels: { enabled: parcelsEnabled, paid }
  };
}
function canUse(feature, userId) {
  const ent = getEntitlements(userId);
  if (feature === 'text_spim') return true;
  if (feature === 'images') return ent.images.enabled;
  if (feature === 'parcels') return ent.parcels.enabled;
  return false;
}
function incrementImageUsage(userId) {
  if (!userId) {
    const key='spim_images_anon_used';
    const used=parseInt(localStorage.getItem(key)||'0',10);
    localStorage.setItem(key, (used+1).toString());
    return;
  }
  const key = 'spim_images_used_'+userId;
  const used = parseInt(localStorage.getItem(key) || '0', 10);
  localStorage.setItem(key, (used+1).toString());
}
function setPaid(userId, paid) {
  localStorage.setItem('spim_paid_'+userId, paid ? 'true' : 'false');
}
window.Entitlements = { getEntitlements, canUse, incrementImageUsage, setPaid };
