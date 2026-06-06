import { createFileRoute } from '@tanstack/react-router'
import { BackLink } from '~/components/BackLink'

interface QA {
  q: string
  a: string
}
interface Section {
  title: string
  items: QA[]
}

// Plain-language, banking-analogy FAQ for wallet holders. Kept in the app
// (not the docs site) so a holder can read it without leaving the wallet.
const SECTIONS: Section[] = [
  {
    title: 'The basics',
    items: [
      {
        q: 'What is the Owl ID wallet?',
        a: "It's an app that holds your digital IDs and lets you prove facts about yourself without handing over all your information. Think of it like the physical wallet in your pocket, except that instead of letting someone copy your whole driver's license, it can show only the single fact they actually need.",
      },
      {
        q: 'What can I keep in it?',
        a: "Multiple identity credentials in one place — for example a Google account, the result of an ID check, and government-issued IDs. You then pick the right one for each situation, the same way you'd choose a debit card versus a credit card at checkout depending on what's appropriate.",
      },
      {
        q: 'How do I unlock it?',
        a: "With your face or fingerprint, using a passkey tied to your device. There's no password to remember or leak. The banking parallel is the fingerprint or Face ID you already use to open your mobile banking app — except here the unlock also protects the keys that sign your proofs.",
      },
    ],
  },
  {
    title: '"Share only what\'s asked" and proofs',
    items: [
      {
        q: 'What does "share only what each request needs" actually mean?',
        a: 'Instead of revealing your full ID, the wallet can present just one fact. The example the app itself uses is proving you\'re over 18 — the other party learns "yes, over 18" and nothing else: not your birth date, not your address, not your ID number.',
      },
      {
        q: 'Banking analogy, please.',
        a: 'Imagine a bar needs to confirm you\'re old enough to be served. Today you hand over a license that also exposes your full name, exact birth date, and home address — far more than the bartender needs. Owl ID is like a bank that can vouch "this customer is over 18" with a signed slip, without printing your account balance, your address, or your date of birth on it. The bar gets the one fact; everything else stays private.',
      },
      {
        q: 'What is a "proof" in this system?',
        a: "A proof is a piece of cryptographically signed evidence that a statement is true, which the other side can check without contacting you again and without seeing your underlying data. In banking terms, it's like a certified, tamper-evident letter from your bank: the recipient can verify the bank's signature is genuine, so they trust the contents without needing to phone the branch.",
      },
      {
        q: 'Does the company see everywhere I use my ID?',
        a: 'The design goal is that proofs are presented directly to whoever is asking, so there\'s no central ledger of "Alex proved their age at these ten bars." Compare this to a credit card, where the card network sees every merchant you visit; selective-disclosure proofs are built to avoid that kind of tracking trail.',
      },
    ],
  },
  {
    title: 'Security and privacy',
    items: [
      {
        q: 'Where is my sensitive data stored?',
        a: "On your device. The app states that nothing secret ever leaves your device — the wallet shares derived proofs, not the raw secrets behind them. The analogy is keeping your account PIN in your head and on your own card, never typing it into a third party's system.",
      },
      {
        q: 'What is a passkey and why does the wallet use one?',
        a: "A passkey is a modern, phishing-resistant login that replaces passwords, unlocked by your device's biometrics. For the wallet it does double duty: it gates access and underpins the cryptographic signing. It's the difference between a password a thief could reuse anywhere and a chip-and-PIN card that only works with the physical card plus your secret.",
      },
      {
        q: 'What happens if I lose my device?',
        a: "Because access is tied to a device passkey and biometrics, losing the device matters a lot — much like losing the phone that runs your banking app. Set up whatever recovery the wallet offers during onboarding, and treat device backup and recovery the way you'd treat keeping your bank's lost-card hotline handy.",
      },
    ],
  },
  {
    title: 'Using it',
    items: [
      {
        q: 'How do I get started?',
        a: "The setup is a short, three-step flow: create an account by choosing a username and a saved passkey for the wallet, sign in with your device, then create your Owl ID. After that you add credentials and you're ready to present them.",
      },
      {
        q: 'How do I actually show a credential to someone?',
        a: 'The other party (a "verifier") starts a request, typically by showing a QR code. Your wallet responds with a proof for exactly what was asked. It\'s the everyday experience of tapping your card on a reader — quick interaction, and only the necessary information moves.',
      },
    ],
  },
]

export const Route = createFileRoute('/faq')({
  component: FaqPage,
})

function FaqPage() {
  return (
    <div className="w-full max-w-2xl mx-auto px-4 pt-6 pb-16 space-y-6">
      <BackLink to="/" label="Back" />
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">FAQ</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Plain-language answers about your wallet, with everyday banking analogies.
        </p>
      </header>

      {SECTIONS.map((section) => (
        <section key={section.title} className="space-y-3">
          <h2 className="text-xs uppercase tracking-wider text-muted-foreground">
            {section.title}
          </h2>
          <div className="space-y-3">
            {section.items.map((item) => (
              <div
                key={item.q}
                className="rounded-lg border border-white/10 bg-card/40 p-4 space-y-1.5"
              >
                <h3 className="text-sm font-medium text-white">{item.q}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{item.a}</p>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
