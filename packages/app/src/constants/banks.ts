import type { IdentityData } from '@owlid/sdk'
import type { Bank } from '~/types/identity'

export const BANKS: Bank[] = [
  { id: 'revolut', name: 'Revolut', color: 'bg-[#0075EB]' },
  { id: 'jpmorgan', name: 'JP Morgan', color: 'bg-[#0A2540]' },
  { id: 'hsbc', name: 'HSBC', color: 'bg-[#DB0011]' },
  { id: 'lloyds', name: 'Lloyds', color: 'bg-[#006A4D]' },
  { id: 'barclays', name: 'Barclays', color: 'bg-[#00AEEF]' },
  { id: 'chase', name: 'Chase', color: 'bg-[#117ACA]' },
  { id: 'bofa', name: 'Bank of America', color: 'bg-[#012169]' },
  { id: 'citi', name: 'Citi', color: 'bg-[#003B70]' },
  { id: 'wells', name: 'Wells Fargo', color: 'bg-[#D71E28]' },
]

export const MOCK_IDENTITY: IdentityData = {
  firstName: 'Alex',
  lastName: 'Mercer',
  birthDate: '1995-04-12',
  birthPlace: 'Seattle, WA, USA',
  nationality: 'American',
  nationalId: 'US-987-65-4321',
  passportNumber: 'A12345678',
  taxId: 'T-555-0199',
  creditScore: 785,
  accountNumber: 'MB-8892-1002-9938',
  email: 'alex.mercer@example.com',
  phone: '+1 (555) 010-9988',
  address: '123 Cyber Lane, Tech District, Neo-City',
  occupation: 'Senior Systems Architect',
  employer: 'Global Corp Dynamics',
  maritalStatus: 'Single',
}
