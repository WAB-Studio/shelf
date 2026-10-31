import type { ReactNode } from "react";
import {
  ArrowLeftRight,
  Banknote,
  Bus,
  Car,
  Film,
  Fuel,
  GraduationCap,
  HeartPulse,
  Home,
  PawPrint,
  Plane,
  Receipt,
  ShoppingBasket,
  Shirt,
  Sparkles,
  Tag,
  Utensils,
  Wifi,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Flex } from "@radix-ui/themes";

// The first keyword a category's name carries picks its glyph; a name matching
// none wears the tag, so a tile is never an empty disc. Written in both
// languages the catalogue is seeded in.
const GLYPHS: [RegExp, LucideIcon][] = [
  [/mercado|super|market|grocer|despensa/i, ShoppingBasket],
  [/restaur|almuerzo|comida|cena|caf[eé]|food|dining|lunch|meal/i, Utensils],
  [/arriendo|alquiler|hipoteca|vivienda|hogar|casa|rent|mortgage|home|housing/i, Home],
  [/internet|wifi|claro|tel[eé]fon|celular|phone/i, Wifi],
  [/servicio|energ|agua|luz|gas|utilit|electric|water/i, Zap],
  [/combustible|gasolina|tanqueo|fuel|gas station/i, Fuel],
  [/transporte|bus|metro|taxi|uber|transit/i, Bus],
  [/carro|auto|veh[ií]culo|parqueadero|car\b|vehicle|parking/i, Car],
  [/salud|m[eé]dic|droguer|farmacia|health|pharmac|doctor/i, HeartPulse],
  [/mascota|veterin|perro|gato|pet/i, PawPrint],
  [/suscrip|netflix|spotify|streaming|cine|entreten|subscription|entertain|movie/i, Film],
  [/educaci|colegio|universidad|curso|school|educat|tuition|course/i, GraduationCap],
  [/ropa|vestuario|cloth|apparel/i, Shirt],
  [/viaje|vacacion|travel|trip|holiday|vuelo|flight/i, Plane],
  [/salario|sueldo|n[oó]mina|ingreso|aporte|salary|income|payroll|wage/i, Banknote],
  [/impuesto|tax|factura|bill|deuda|debt/i, Receipt],
  [/cuidado|belleza|personal|beauty|care/i, Sparkles],
];

function glyphFor(name: string | null | undefined, transfer: boolean): LucideIcon {
  if (transfer) return ArrowLeftRight;
  const match = name ? GLYPHS.find(([pattern]) => pattern.test(name)) : undefined;
  return match ? match[1] : Tag;
}

function drawGlyph(name: string | null | undefined, transfer: boolean, size: number): ReactNode {
  const Glyph = glyphFor(name, transfer);
  return <Glyph size={Math.round(size * 0.5)} strokeWidth={2} aria-hidden />;
}

// White on a dark colour, the brand ink on a light one (yellow, lime): the glyph
// reads on every stored colour. A colour that is not a hex keeps white.
function inkOn(color: string): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return "#fff";
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? "var(--brand-ink)" : "#fff";
}

// Below this a tile is a legend dot, not a place to draw a glyph.
const GLYPH_MIN_SIZE = 28;

// The circular coloured chip a category wears in a movement row. The colour is a
// stored CSS value; a category without one falls back to the neutral surface. From
// 28px up the chip carries a glyph chosen from the category's `name` (a transfer
// wears its arrows), unless the caller hands one in as `icon`.
export function CategoryTile({
  color,
  icon,
  name,
  transfer = false,
  size = 40,
}: {
  color: string | null;
  icon?: ReactNode;
  name?: string | null;
  transfer?: boolean;
  size?: number;
}) {
  return (
    <Flex
      align="center"
      justify="center"
      flexShrink="0"
      style={{
        width: size,
        height: size,
        borderRadius: "9999px",
        background: color ?? "var(--gray-a3)",
        color: color ? inkOn(color) : "var(--gray-11)",
      }}
    >
      {icon}
      {icon === undefined && size >= GLYPH_MIN_SIZE && drawGlyph(name, transfer, size)}
    </Flex>
  );
}
