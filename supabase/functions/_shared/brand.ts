// Customer-facing email/SMS branding, resolved from the lot a session belongs to — the same
// lot -> operator link the pay page uses. A lot with no operator gets the original City Park
// look exactly as before. The lot's category (marina vs parking) independently controls the
// wording (dockage/registration/slip), mirroring the pay page's category-vs-operator split.

const DEFAULT_LOGO = 'https://sldahhdbvcxdlqdhmsjd.supabase.co/storage/v1/object/public/assets/Logo%201.png';
const SUPPORT_EMAIL = 'info@cityparkmanagement.com';

export interface Brand {
  operatorId: string | null;
  marina: boolean;
  name: string;
  shortName: string;
  smsName: string;
  logoUrl: string;
  logoHeight: number;
  headerBg: string;
  accent: string;
  linkBase: string; // scheme-less, for SMS
  baseUrl: string;  // for email links
  footer: string;
}

export function defaultBrand(marina = false): Brand {
  return {
    operatorId: null,
    marina,
    name: 'City Park Management',
    shortName: 'City Park',
    smsName: 'City Park Management',
    logoUrl: DEFAULT_LOGO,
    logoHeight: 48,
    headerBg: '#0d0d0d',
    accent: '#b5d96e',
    linkBase: 'cityparkmanagement.app',
    baseUrl: 'https://www.cityparkmanagement.app',
    footer: `City Park Management · ${SUPPORT_EMAIL}`,
  };
}

export async function brandForLot(supabase: any, lot: any): Promise<Brand> {
  const base = defaultBrand(lot?.category === 'marina');
  if (!lot?.operator_id) return base;
  const { data: op } = await supabase.from('operators').select('*').eq('id', lot.operator_id).maybeSingle();
  if (!op || op.active === false) return base;
  const shortName = String(op.name).replace(/\s+Management$/i, '');
  const host = op.subdomain ? `${op.subdomain}.cityparkmanagement.app` : 'cityparkmanagement.app';
  return {
    ...base,
    operatorId: op.id,
    name: op.name,
    shortName,
    // Texts keep the registered sender name in parentheses — the SMS campaign is registered
    // to City Park Management, and the consent checkbox names it as the sender.
    smsName: `${shortName} (City Park Management)`,
    logoUrl: op.logo_url || base.logoUrl,
    logoHeight: 72,
    headerBg: '#000000', // the operator logo's own background is pure black
    accent: op.accent || base.accent,
    linkBase: host,
    baseUrl: `https://${host}`,
    footer: `${op.name} · Operated by City Park Management · ${SUPPORT_EMAIL}`,
  };
}

export function escHtml(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}

export const emailHeaderRow = (b: Brand) =>
  `<tr><td style="background:${b.headerBg};padding:24px 32px;border-bottom:5px solid ${b.accent};"><img src="${b.logoUrl}" alt="${b.name}" style="height:${b.logoHeight}px;display:block;"></td></tr>`;

export const emailFooterRow = (b: Brand) =>
  `<tr><td style="background:#f5f5f5;padding:16px 32px;text-align:center;font-size:11px;color:#888;">${b.footer}</td></tr>`;

export function receiptWords(b: Brand) {
  return b.marina
    ? {
        title: 'Dockage Receipt',
        ended: 'Your dockage session has ended. Here is your receipt.',
        idLabel: 'Registration',
        subject: `Your ${b.shortName} Dockage Receipt`,
      }
    : {
        title: 'Parking Receipt',
        ended: 'Your parking session has ended. Here is your receipt.',
        idLabel: 'Plate',
        subject: 'Your City Park Parking Receipt',
      };
}

const slipPart = (s: any) => (s?.slip_number ? ` (Slip ${s.slip_number})` : '');

export function expiryWarningSms(b: Brand, s: any, lot: any): string {
  const lotName = lot?.name || (b.marina ? 'the marina' : 'the lot');
  const link = `${b.linkBase}/extend?session=${s.id}`;
  if (b.marina) {
    return `${b.smsName}: Your dockage for ${s.plate} at ${lotName}${slipPart(s)} expires in 20 min. Tap to extend: ${link}`;
  }
  return `${b.smsName}: Your parking for plate ${s.plate} at ${lotName} (Zone ${lot?.zone || ''}) expires in 20 min. Tap to extend: ${link}`;
}

export function receiptSms(b: Brand, s: any, lot: any, dur: string): string {
  const lotName = lot?.name || (b.marina ? 'the marina' : 'the lot');
  if (b.marina) {
    return `${b.smsName}: Receipt for ${s.plate} at ${lotName}${slipPart(s)}. Duration: ${dur}. Amount paid: $${s.paid.toFixed(2)}. Thank you for docking with us!`;
  }
  return `${b.smsName}: Receipt for ${s.plate} at ${lotName} (Zone ${lot?.zone || ''}). Duration: ${dur}. Amount paid: $${s.paid.toFixed(2)}. Thank you for parking with us!`;
}
