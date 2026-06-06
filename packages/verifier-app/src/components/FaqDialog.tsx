import { HelpCircle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@owlid/ui/components/ui/dialog'

interface QA {
  q: string
  a: string
}
interface Section {
  title: string
  items: QA[]
}

// Verifier-side FAQ, in plain language with banking analogies. Lives in the
// verifier app (not the docs site) so an operator can read it in place.
const SECTIONS: Section[] = [
  {
    title: 'The basics',
    items: [
      {
        q: 'What is the Owl ID Verifier?',
        a: "It's the tool used by the party who needs to check an ID — a business, venue, or service. It confirms that a credential someone presents is genuine, comes from a trusted source, and is still valid. In banking terms, it's the equivalent of the point-of-sale terminal and the fraud checks behind it: the merchant doesn't take your word for it, the terminal verifies the card.",
      },
      {
        q: 'How does a verification happen?',
        a: "The verifier either scans the holder's QR code with a camera to open a live session, or, if there's no camera, uses a manual \"challenge and paste\" flow. Either way, the holder's wallet supplies a proof, and the verifier checks it.",
      },
      {
        q: 'What\'s the "challenge" step for?',
        a: "The verifier issues a fresh, one-time challenge (valid for about five minutes) that the holder must sign right then. This proves the holder is presenting live and isn't replaying an old, captured response. The banking parallel is the one-time code your bank texts you for a transaction: it's only good once, and only for that moment, so a stolen copy is useless later.",
      },
    ],
  },
  {
    title: 'Trust, proofs, and blockchain',
    items: [
      {
        q: 'How does the verifier know a credential is real and not forged?',
        a: 'Every credential is signed by an issuer, and the verifier only accepts credentials signed by keys on its "trusted issuers" list. If the signature doesn\'t match a trusted key, it\'s rejected. This is exactly how a payment terminal trusts a card: not because the card looks nice, but because it carries a valid cryptographic signature from a recognized bank or network.',
      },
      {
        q: 'What is a "trusted issuer," in banking terms?',
        a: "It's like the list of card networks and banks a merchant's terminal will accept. A handwritten IOU isn't honored; a card from a recognized issuer is. Owl ID works the same way — a credential is only trusted if it's signed by a recognized issuer's key.",
      },
      {
        q: 'Where does the blockchain come in, and why?',
        a: 'The blockchain (here, a network called Midnight) is used as a shared, tamper-resistant public record of which credentials have been revoked — that is, cancelled or invalidated. The verifier watches revocations broadcast on that chain and can check whether a specific credential has been revoked. Think of it as the industry-wide "cancelled cards" hotlist: when a bank cancels a stolen card, every terminal needs to find out, and no single merchant should be able to secretly rewrite that list.',
      },
      {
        q: 'So the blockchain stores my personal data?',
        a: "No — that's the key point to demystify. It isn't a database of your identity. It's used for the revocation list: references to which credentials are no longer valid, so any verifier can independently confirm a credential hasn't been cancelled. Your name and personal facts aren't posted to it. The analogy is that the cancelled-card hotlist contains card identifiers and status, not your full banking history.",
      },
      {
        q: 'Why use a blockchain instead of just a normal company server?',
        a: "A shared ledger means no single party can quietly tamper with the revocation record, and every verifier sees the same truth. It's like a cancelled-card list that no individual merchant or even one bank can secretly edit, which makes the whole system more trustworthy and harder to game.",
      },
      {
        q: 'What\'s a "proof" from the verifier\'s side?',
        a: "The verifier receives a signed presentation (in a format called SD-JWT VC) and checks three things: the signature traces back to a trusted issuer, the holder answered the live challenge, and the credential hasn't been revoked. Only if all of that holds does it accept. It mirrors a card payment: valid signature, live authorization, and not on the cancelled list.",
      },
    ],
  },
  {
    title: 'What a verification result looks like',
    items: [
      {
        q: 'What happens when verification succeeds or fails?',
        a: 'The verifier shows a clear result. A failure produces a plain message and the reason, with the option to try another. A revocation check returns either a red "Revoked" or a green "Active — not revoked." It\'s the familiar "approved" versus "declined" you see on a card reader, with a short reason when something doesn\'t go through.',
      },
      {
        q: 'Does the verifier keep a record?',
        a: "Yes — it keeps a history of verifications it has performed, with timestamps and outcomes, similar to a merchant's transaction log. This is the verifier's own record of checks it ran, not a feed of everywhere you personally used your wallet.",
      },
      {
        q: 'Can the verifier see all my information when it checks one fact?',
        a: "No. Because the wallet presents only the requested fact (like \"over 18\"), the verifier learns just that, plus that it's validly signed and unrevoked. The bartender confirms you're old enough without ever seeing your address — that's the whole point of selective disclosure.",
      },
    ],
  },
]

export function FaqDialog() {
  return (
    <Dialog>
      <DialogTrigger className="inline-flex items-center gap-1 underline-offset-2 hover:underline hover:text-foreground">
        <HelpCircle className="w-3 h-3" /> FAQ
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Verifier FAQ</DialogTitle>
          <DialogDescription>
            Plain-language answers about checking IDs, with everyday banking analogies.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {SECTIONS.map((section) => (
            <section key={section.title} className="space-y-2.5">
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground">
                {section.title}
              </h3>
              {section.items.map((item) => (
                <div
                  key={item.q}
                  className="rounded-lg border border-white/10 bg-card/40 p-3 space-y-1"
                >
                  <p className="text-sm font-medium text-white">{item.q}</p>
                  <p className="text-sm text-muted-foreground leading-relaxed">{item.a}</p>
                </div>
              ))}
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
