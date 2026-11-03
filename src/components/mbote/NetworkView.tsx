"use client";

import {
  Archive,
  Hourglass,
  Mail,
  MapPinned,
  ShieldCheck,
  Waves,
  Eye,
} from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Card, CardContent } from "@/components/ui/card";
import { BitChatBridge } from "./BitChatBridge";
import MeshSimulation from "./MeshSimulation";
import { RouteurPanel } from "./RouteurPanel";

const PROTOCOL_STATS = [
  { icon: Hourglass, value: "7", label: "sauts TTL max", sub: "clampé à 5 en zone dense" },
  { icon: Mail, value: "4 → 8", label: "budget de copies", sub: "courriers spray-and-wait" },
  { icon: Archive, value: "3", label: "courriers / message", sub: "+ outbox local 24 h" },
  { icon: Waves, value: "6 h", label: "fenêtre gossip", sub: "historique sync entre pairs" },
];

export function NetworkView() {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-bold tracking-tight">Le réseau, en direct</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Simulation fidèle des paramètres du protocole BitChat (whitepaper v2.0, domaine
          public) : inondation contrôlée avec TTL et gigue, courriers « spray-and-wait » pour
          joindre un pair hors de portée.
        </p>
      </div>

      {/* Routeur de transports (DORS) : santé + journal des décisions */}
      <RouteurPanel />

      {/* Tunnel réel : encapsulation BitChat → passerelle → VPS */}
      <BitChatBridge />

      <Card className="p-2">
        <CardContent className="p-2">
          <MeshSimulation />
        </CardContent>
      </Card>

      {/* Chiffres clés du protocole */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {PROTOCOL_STATS.map(({ icon: Icon, value, label, sub }) => (
          <Card key={label}>
            <CardContent className="p-4">
              <Icon className="size-4 text-primary" aria-hidden="true" />
              <p className="mt-2 font-mono text-xl font-bold text-primary">{value}</p>
              <p className="text-xs font-medium">{label}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Architecture */}
      <Card>
        <CardContent className="p-4">
          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="archi">
              <AccordionTrigger className="text-sm">
                <span className="flex items-center gap-2">
                  <Waves className="size-4 text-primary" aria-hidden="true" />
                  Architecture à double transport
                </span>
              </AccordionTrigger>
              <AccordionContent className="text-xs leading-relaxed text-muted-foreground">
                Chaque message tente d&apos;abord le <strong>mesh Bluetooth LE</strong> (portée
                locale, multi-sauts, zéro infrastructure) puis bascule sur{" "}
                <strong>Nostr</strong> (relays internet mondiaux, canaux géohash) si personne
                n&apos;est à portée. Le routeur choisit le meilleur transport automatiquement —
                ici, la file locale « courrier » joue le rôle du store-and-forward.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="crypto">
              <AccordionTrigger className="text-sm">
                <span className="flex items-center gap-2">
                  <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
                  Chiffrement : Noise XX en session, Noise X hors-ligne
                </span>
              </AccordionTrigger>
              <AccordionContent className="text-xs leading-relaxed text-muted-foreground">
                Les pairs en direct établissent une session <strong>Noise XX</strong>
                (Curve25519, ChaCha20-Poly1305) : authentification mutuelle et confidentialité
                persistante. Le courrier hors-ligne est scellé en <strong>Noise X</strong> vers
                la clé statique du destinataire — les relais ne portent que du ciphertext opaque.
                Cette démo implémente l&apos;équivalent WebCrypto : ECDH P-256 + AES-GCM 256.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="store">
              <AccordionTrigger className="text-sm">
                <span className="flex items-center gap-2">
                  <Archive className="size-4 text-primary" aria-hidden="true" />
                  Store-and-forward : outbox, courriers, gossip
                </span>
              </AccordionTrigger>
              <AccordionContent className="text-xs leading-relaxed text-muted-foreground">
                Quatre mécanismes couvrent « le destinataire n&apos;est pas là » : l&apos;outbox
                persistante de l&apos;expéditeur, les <strong>courriers</strong> (3 pairs
                transporteurs, budget de copies 4→8, tags rotatifs quotidiens), la
                réconciliation d&apos;historique public par filtres de Golomb (GCS) toutes les
                15 s, et les boîtes aux lettres Nostr avec rappel de 24 h.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="geohash">
              <AccordionTrigger className="text-sm">
                <span className="flex items-center gap-2">
                  <MapPinned className="size-4 text-primary" aria-hidden="true" />
                  Canaux géohash : la carte devient un espace social
                </span>
              </AccordionTrigger>
              <AccordionContent className="text-xs leading-relaxed text-muted-foreground">
                Un géohash encode lat/lng en cellules emboîtables : 7 caractères = un bloc
                (~150 m), 5 = une ville (~5 km), 2 = un pays. Chaque cellule est un salon
                public transporté par les relays ; les identités y sont éphémères par zone.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="meta">
              <AccordionTrigger className="text-sm">
                <span className="flex items-center gap-2">
                  <Eye className="size-4 text-amber-500" aria-hidden="true" />
                  Limites honnêtes (métadonnées)
                </span>
              </AccordionTrigger>
              <AccordionContent className="text-xs leading-relaxed text-muted-foreground">
                Le whitepaper le dit lui-même : l&apos;ID pair est stable et les annonces
                publient les clés en clair — un observateur radio peut suivre un appareil dans
                l&apos;espace-temps. Les identités rotatives sont listées en « travaux futurs ».
                Et côté démo : l&apos;ECDH statique-statique des DM n&apos;offre pas de
                confidentialité persistante (pas de prekeys). Transparence totale.
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
      </Card>
    </div>
  );
}
