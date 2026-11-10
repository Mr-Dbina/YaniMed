/**
 * Seeds the exam-flow fixture subject "ZZ-fake-mocktest" on whichever database
 * .env points at (the main DB).
 *
 * Modes:
 *   (default)    dry run: prints the plan, counts existing rows, writes nothing
 *   --apply      creates 1 subject, 1 READY document, 13 topics, 25 ACTIVE
 *                questions, 100 choices, 25 citations
 *   --cleanup    prints counts, then deletes ONLY the subject named exactly
 *                "ZZ-fake-mocktest"; every child row cascades from it
 *
 * Every read and write is keyed by SUBJECT_NAME or by an id obtained from that
 * subject. No other subject, document, chunk, chat or message row is touched.
 *
 * A failure part-way through --apply leaves a partial fixture. Re-running
 * --cleanup removes all of it through the Subject -> * ON DELETE CASCADE
 * relations; --apply then starts clean.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

const SUBJECT_NAME = 'ZZ-fake-mocktest';
const DOCUMENT_TITLE = 'FAKE Mock Test Fixture Document (ZZ-fake-mocktest)';
const DOCUMENT_FILE_URL = 'fake/zz-fake-mocktest.pdf';
const DOCUMENT_PAGE_COUNT = 60;
const DOCUMENT_FILE_SIZE = 1024;

/** Same budget as exam.service.ts TX_OPTIONS; the main DB is far away. */
const TX_OPTIONS = { maxWait: 30000, timeout: 30000 };

/**
 * The Nest app loads .env through ConfigModule, but a plain script bypasses
 * Nest. Same minimal loader as scripts/check-env.ts (dotenv is only a
 * transitive dependency, so it is not imported directly).
 */
function loadEnvFile(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    console.error('.env not found. This script reads the main DB config from .env.');
    process.exit(1);
  }

  for (const line of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

interface ChoiceFixture {
  text: string;
  isCorrect: boolean;
  explanation: string;
}

interface QuestionFixture {
  topicKey: string;
  topicName: string;
  stem: string;
  leadIn?: string;
  educationalObjective: string;
  pageNumber: number;
  choices: ChoiceFixture[];
}

/**
 * 13 topics, at most 2 questions each, 25 questions total. Strings are not
 * real teaching material: each one carries an explicit FAKE marker.
 * Correct positions are deliberately spread over 1..4.
 */
const QUESTIONS: QuestionFixture[] = [
  {
    topicKey: 'fake-neonatal-jaundice',
    topicName: 'FAKE Neonatal Jaundice',
    stem: 'FAKE Q01: A 3-day-old term infant is visibly jaundiced up to the umbilicus. He feeds well, has passed stool, and has gained weight since birth. Which single test is the most appropriate next step?',
    leadIn: 'FAKE lead-in: choose the best first investigation.',
    educationalObjective: 'FAKE objective: recognise when to measure a serum bilirubin in a well newborn.',
    pageNumber: 12,
    choices: [
      { text: 'FAKE: Blood culture and lumbar puncture', isCorrect: false, explanation: 'FAKE: a well, feeding infant with mild jaundice has no sepsis features, so cultures and lumbar puncture are not the first step.' },
      { text: 'FAKE: Total serum bilirubin', isCorrect: true, explanation: 'FAKE: a measured bilirubin is needed to plot the infant on the treatment threshold chart; the visual level alone is unreliable.' },
      { text: 'FAKE: Direct Coombs test', isCorrect: false, explanation: 'FAKE: Coombs is reserved for suspected haemolysis, such as early jaundice or a known blood group mismatch.' },
      { text: 'FAKE: Abdominal ultrasound', isCorrect: false, explanation: 'FAKE: imaging is for conjugated or prolonged jaundice, not a well 3-day-old with typical physiological jaundice.' },
    ],
  },
  {
    topicKey: 'fake-neonatal-jaundice',
    topicName: 'FAKE Neonatal Jaundice',
    stem: 'FAKE Q02: A 36-week infant becomes jaundiced at 12 hours of age. Which feature most strongly suggests haemolytic disease rather than physiological jaundice?',
    educationalObjective: 'FAKE objective: identify the timing that makes neonatal jaundice pathological.',
    pageNumber: 14,
    choices: [
      { text: 'FAKE: Jaundice confined to the face', isCorrect: false, explanation: 'FAKE: facial-only jaundice is mild and does not by itself indicate haemolysis.' },
      { text: 'FAKE: Peak bilirubin on day 5', isCorrect: false, explanation: 'FAKE: a later peak is typical of physiological jaundice in a term infant.' },
      { text: 'FAKE: Jaundice within the first 24 hours', isCorrect: true, explanation: 'FAKE: jaundice in the first 24 hours is always pathological and haemolysis is a leading cause.' },
      { text: 'FAKE: Breastfeeding at the time of onset', isCorrect: false, explanation: 'FAKE: breastfeeding jaundice appears later and is not an early-onset haemolytic pattern.' },
    ],
  },
  {
    topicKey: 'fake-infant-feeding',
    topicName: 'FAKE Infant Feeding',
    stem: 'FAKE Q03: A mother asks how long her healthy term infant should be exclusively breastfed. What is the recommended duration?',
    educationalObjective: 'FAKE objective: state the recommended exclusive breastfeeding period.',
    pageNumber: 20,
    choices: [
      { text: 'FAKE: About 6 months, then complementary foods', isCorrect: true, explanation: 'FAKE: exclusive breastfeeding for around 6 months, with continued breastfeeding afterwards, is the standard recommendation.' },
      { text: 'FAKE: About 2 months, then formula', isCorrect: false, explanation: 'FAKE: stopping at 2 months removes the protection and nutrition of breast milk far too early.' },
      { text: 'FAKE: About 12 months with no solids', isCorrect: false, explanation: 'FAKE: solids are needed from about 6 months for iron and energy.' },
      { text: 'FAKE: Until the infant doubles birth weight', isCorrect: false, explanation: 'FAKE: weight gain is not the criterion; age and developmental readiness guide introduction of solids.' },
    ],
  },
  {
    topicKey: 'fake-infant-feeding',
    topicName: 'FAKE Infant Feeding',
    stem: 'FAKE Q04: A family plans to stop breastfeeding at 8 months and give unmodified cow milk. Which risk should be explained?',
    educationalObjective: 'FAKE objective: explain why whole cow milk is avoided before 12 months.',
    pageNumber: 22,
    choices: [
      { text: 'FAKE: Cow milk causes immediate type 1 diabetes', isCorrect: false, explanation: 'FAKE: no such immediate causal link exists; the concern is nutritional, not diabetogenic.' },
      { text: 'FAKE: Cow milk has too little calcium', isCorrect: false, explanation: 'FAKE: cow milk has more calcium than breast milk; calcium is not the limiting nutrient.' },
      { text: 'FAKE: Cow milk prevents iron absorption only in adults', isCorrect: false, explanation: 'FAKE: the effect on iron absorption applies to infants too, but this answer misstates the scope.' },
      { text: 'FAKE: Low iron content and gastrointestinal blood loss', isCorrect: true, explanation: 'FAKE: unmodified cow milk is poor in iron and can cause occult blood loss, so it is avoided before 12 months.' },
    ],
  },
  {
    topicKey: 'fake-immunisation',
    topicName: 'FAKE Immunisation',
    stem: 'FAKE Q05: Which of the following is NOT a live attenuated vaccine?',
    educationalObjective: 'FAKE objective: distinguish live attenuated from inactivated vaccines.',
    pageNumber: 27,
    choices: [
      { text: 'FAKE: Measles-mumps-rubella', isCorrect: false, explanation: 'FAKE: MMR is live attenuated.' },
      { text: 'FAKE: Varicella', isCorrect: false, explanation: 'FAKE: varicella vaccine is live attenuated.' },
      { text: 'FAKE: Diphtheria-tetanus-acellular pertussis', isCorrect: true, explanation: 'FAKE: DTaP contains toxoids and acellular proteins, so it is not a live vaccine.' },
      { text: 'FAKE: Rotavirus', isCorrect: false, explanation: 'FAKE: rotavirus vaccine is live attenuated, given orally.' },
    ],
  },
  {
    topicKey: 'fake-immunisation',
    topicName: 'FAKE Immunisation',
    stem: 'FAKE Q06: A newborn in a high-burden setting receives BCG. Against which outcome does it give the clearest protection?',
    educationalObjective: 'FAKE objective: state the main benefit of BCG vaccination.',
    pageNumber: 29,
    choices: [
      { text: 'FAKE: Prevention of all respiratory infections', isCorrect: false, explanation: 'FAKE: BCG is not a general respiratory vaccine.' },
      { text: 'FAKE: Disseminated and meningeal tuberculosis in young children', isCorrect: true, explanation: 'FAKE: BCG protects best against severe disseminated and meningeal disease in early childhood.' },
      { text: 'FAKE: Complete lifelong sterilising immunity to tuberculosis', isCorrect: false, explanation: 'FAKE: protection is partial and wanes; BCG is not sterilising.' },
      { text: 'FAKE: Prevention of latent tuberculosis infection', isCorrect: false, explanation: 'FAKE: BCG does not reliably prevent infection itself.' },
    ],
  },
  {
    topicKey: 'fake-febrile-seizure',
    topicName: 'FAKE Febrile Seizure',
    stem: 'FAKE Q07: A 2-year-old has a generalised tonic-clonic seizure lasting 4 minutes during a febrile illness. Examination after the event is normal. Which description fits a simple febrile seizure?',
    educationalObjective: 'FAKE objective: list the features that define a simple febrile seizure.',
    pageNumber: 31,
    choices: [
      { text: 'FAKE: Focal onset with post-ictal weakness', isCorrect: false, explanation: 'FAKE: focal features and post-ictal weakness suggest a complex febrile seizure or another cause.' },
      { text: 'FAKE: Duration over 30 minutes', isCorrect: false, explanation: 'FAKE: a prolonged event is febrile status epilepticus, not a simple febrile seizure.' },
      { text: 'FAKE: Recurrent events within the same illness', isCorrect: false, explanation: 'FAKE: more than one event in 24 hours makes the seizure complex.' },
      { text: 'FAKE: Generalised, under 15 minutes, age 6 months to 5 years', isCorrect: true, explanation: 'FAKE: generalised, brief and within the typical age band defines the simple form.' },
    ],
  },
  {
    topicKey: 'fake-febrile-seizure',
    topicName: 'FAKE Febrile Seizure',
    stem: 'FAKE Q08: A child has recovered fully after a first simple febrile seizure. Which investigation is routinely required?',
    educationalObjective: 'FAKE objective: avoid unnecessary investigation after a simple febrile seizure.',
    pageNumber: 33,
    choices: [
      { text: 'FAKE: None beyond identifying the fever source', isCorrect: true, explanation: 'FAKE: routine EEG, imaging and electrolytes add nothing after a simple febrile seizure; look for the fever source.' },
      { text: 'FAKE: Routine EEG before discharge', isCorrect: false, explanation: 'FAKE: an EEG does not change management and can be misleading.' },
      { text: 'FAKE: Head CT in every case', isCorrect: false, explanation: 'FAKE: imaging is reserved for focal signs or raised intracranial pressure.' },
      { text: 'FAKE: Serum electrolytes in every case', isCorrect: false, explanation: 'FAKE: electrolytes are not routinely needed in a simple febrile seizure.' },
    ],
  },
  {
    topicKey: 'fake-acute-asthma',
    topicName: 'FAKE Acute Asthma',
    stem: 'FAKE Q09: A 7-year-old with asthma presents with wheeze and mild intercostal recession. Which treatment is first line?',
    educationalObjective: 'FAKE objective: choose the first-line reliever in acute asthma.',
    pageNumber: 35,
    choices: [
      { text: 'FAKE: Oral antibiotic', isCorrect: false, explanation: 'FAKE: bacterial infection is uncommon; antibiotics do not treat bronchospasm.' },
      { text: 'FAKE: Inhaled corticosteroid alone', isCorrect: false, explanation: 'FAKE: a controller does not relieve an acute attack.' },
      { text: 'FAKE: Inhaled salbutamol with a spacer', isCorrect: true, explanation: 'FAKE: a short-acting beta-2 agonist by spacer is the first-line reliever.' },
      { text: 'FAKE: Oral montelukast alone', isCorrect: false, explanation: 'FAKE: montelukast is a maintenance drug, too slow for an acute attack.' },
    ],
  },
  {
    topicKey: 'fake-acute-asthma',
    topicName: 'FAKE Acute Asthma',
    stem: 'FAKE Q10: A child has daytime symptoms more than twice a week but no night waking. Which regular treatment is appropriate?',
    educationalObjective: 'FAKE objective: match preventer therapy to symptom frequency.',
    pageNumber: 37,
    choices: [
      { text: 'FAKE: No regular treatment at all', isCorrect: false, explanation: 'FAKE: symptoms more than twice a week already need a preventer.' },
      { text: 'FAKE: Low-dose inhaled corticosteroid', isCorrect: true, explanation: 'FAKE: a low-dose inhaled corticosteroid is the standard preventer at this step.' },
      { text: 'FAKE: Long-acting beta-2 agonist alone', isCorrect: false, explanation: 'FAKE: a LABA is never used alone in asthma.' },
      { text: 'FAKE: Oral corticosteroid course', isCorrect: false, explanation: 'FAKE: oral steroids are for exacerbations, not maintenance.' },
    ],
  },
  {
    topicKey: 'fake-gastroenteritis-dehydration',
    topicName: 'FAKE Gastroenteritis and Dehydration',
    stem: 'FAKE Q11: A child with acute diarrhoea is alert, drinking, and has slightly sunken eyes. Which treatment is correct?',
    educationalObjective: 'FAKE objective: use oral rehydration for mild to moderate dehydration.',
    pageNumber: 39,
    choices: [
      { text: 'FAKE: Stop all fluids until the diarrhoea settles', isCorrect: false, explanation: 'FAKE: withholding fluids worsens dehydration.' },
      { text: 'FAKE: Loperamide to slow stool output', isCorrect: false, explanation: 'FAKE: antimotility drugs are avoided in children with acute gastroenteritis.' },
      { text: 'FAKE: Antibiotics for every case', isCorrect: false, explanation: 'FAKE: most acute diarrhoea is viral; antibiotics are not routine.' },
      { text: 'FAKE: Oral rehydration solution in small frequent amounts', isCorrect: true, explanation: 'FAKE: oral rehydration is first line for mild to moderate dehydration.' },
    ],
  },
  {
    topicKey: 'fake-gastroenteritis-dehydration',
    topicName: 'FAKE Gastroenteritis and Dehydration',
    stem: 'FAKE Q12: A 1-year-old with diarrhoea is lethargic with a very slow skin pinch and cold extremities. What is the immediate priority?',
    educationalObjective: 'FAKE objective: recognise severe dehydration and start intravenous fluid.',
    pageNumber: 41,
    choices: [
      { text: 'FAKE: Intravenous fluid resuscitation', isCorrect: true, explanation: 'FAKE: shock with severe dehydration needs immediate intravenous fluid.' },
      { text: 'FAKE: Oral rehydration only, reassess in 4 hours', isCorrect: false, explanation: 'FAKE: oral fluid alone is unsafe in shock.' },
      { text: 'FAKE: Stool culture before any fluid', isCorrect: false, explanation: 'FAKE: resuscitation must not wait for culture results.' },
      { text: 'FAKE: Antiemetic and discharge', isCorrect: false, explanation: 'FAKE: discharging a shocked child is unsafe.' },
    ],
  },
  {
    topicKey: 'fake-group-a-strep',
    topicName: 'FAKE Group A Streptococcus',
    stem: 'FAKE Q13: A 9-year-old has fever, tonsillar exudate and tender anterior cervical nodes. A rapid test confirms group A streptococcus. Which treatment is first line?',
    educationalObjective: 'FAKE objective: treat confirmed streptococcal pharyngitis with penicillin or amoxicillin.',
    pageNumber: 43,
    choices: [
      { text: 'FAKE: Ciprofloxacin', isCorrect: false, explanation: 'FAKE: quinolones are not the standard choice for streptococcal pharyngitis.' },
      { text: 'FAKE: Topical antiseptic spray only', isCorrect: false, explanation: 'FAKE: topical treatment does not eradicate the organism.' },
      { text: 'FAKE: Oral amoxicillin or penicillin', isCorrect: true, explanation: 'FAKE: penicillin remains the first-line agent, and amoxicillin gives the same coverage.' },
      { text: 'FAKE: Oral vancomycin', isCorrect: false, explanation: 'FAKE: vancomycin is not absorbed orally and is not used for pharyngitis.' },
    ],
  },
  {
    topicKey: 'fake-group-a-strep',
    topicName: 'FAKE Group A Streptococcus',
    stem: 'FAKE Q14: Why is confirmed streptococcal pharyngitis treated even when symptoms are mild?',
    educationalObjective: 'FAKE objective: link treatment to prevention of non-suppurative complications.',
    pageNumber: 44,
    choices: [
      { text: 'FAKE: To prevent all future sore throats', isCorrect: false, explanation: 'FAKE: treatment does not confer general immunity.' },
      { text: 'FAKE: To reduce the risk of acute rheumatic fever', isCorrect: true, explanation: 'FAKE: prompt treatment lowers the risk of acute rheumatic fever.' },
      { text: 'FAKE: To cure carriage within 24 hours', isCorrect: false, explanation: 'FAKE: clearance is not instant and carriage is not the main target.' },
      { text: 'FAKE: To prevent nephrotic syndrome', isCorrect: false, explanation: 'FAKE: post-streptococcal glomerulonephritis is not prevented by antibiotics.' },
    ],
  },
  {
    topicKey: 'fake-otitis-media',
    topicName: 'FAKE Acute Otitis Media',
    stem: 'FAKE Q15: A 3-year-old has ear pain, fever and a bulging tympanic membrane. Which antibiotic is first line?',
    educationalObjective: 'FAKE objective: choose the first-line antibiotic in acute otitis media.',
    pageNumber: 46,
    choices: [
      { text: 'FAKE: Topical corticosteroid drops', isCorrect: false, explanation: 'FAKE: topical drops treat otitis externa, not middle-ear infection.' },
      { text: 'FAKE: Oral azithromycin', isCorrect: false, explanation: 'FAKE: macrolides have high pneumococcal resistance and are not first line.' },
      { text: 'FAKE: Oral ciprofloxacin', isCorrect: false, explanation: 'FAKE: quinolones are reserved and not the first-line choice in children.' },
      { text: 'FAKE: High-dose oral amoxicillin', isCorrect: true, explanation: 'FAKE: high-dose amoxicillin covers the common pathogens, including many resistant pneumococci.' },
    ],
  },
  {
    topicKey: 'fake-otitis-media',
    topicName: 'FAKE Acute Otitis Media',
    stem: 'FAKE Q16: Which organism is the most common cause of acute otitis media in children?',
    educationalObjective: 'FAKE objective: recall the leading pathogen in acute otitis media.',
    pageNumber: 47,
    choices: [
      { text: 'FAKE: Streptococcus pneumoniae', isCorrect: true, explanation: 'FAKE: pneumococcus is the most frequent cause, followed by non-typeable Haemophilus influenzae.' },
      { text: 'FAKE: Pseudomonas aeruginosa', isCorrect: false, explanation: 'FAKE: pseudomonas is typical of otitis externa in swimmers.' },
      { text: 'FAKE: Streptococcus pyogenes only', isCorrect: false, explanation: 'FAKE: group A streptococcus causes some cases but is not the most common.' },
      { text: 'FAKE: Candida albicans', isCorrect: false, explanation: 'FAKE: fungal infection is uncommon and usually follows prolonged topical antibiotics.' },
    ],
  },
  {
    topicKey: 'fake-kawasaki-disease',
    topicName: 'FAKE Kawasaki Disease',
    stem: 'FAKE Q17: Which finding is NOT part of the classic clinical criteria for Kawasaki disease?',
    educationalObjective: 'FAKE objective: separate diagnostic criteria from laboratory associations.',
    pageNumber: 49,
    choices: [
      { text: 'FAKE: Non-purulent conjunctivitis', isCorrect: false, explanation: 'FAKE: bilateral non-purulent conjunctivitis is a diagnostic criterion.' },
      { text: 'FAKE: Polymorphous rash', isCorrect: false, explanation: 'FAKE: a polymorphous rash is a diagnostic criterion.' },
      { text: 'FAKE: Thrombocytosis', isCorrect: true, explanation: 'FAKE: thrombocytosis is a supportive laboratory finding, not a clinical criterion.' },
      { text: 'FAKE: Cervical lymphadenopathy over 1.5 cm', isCorrect: false, explanation: 'FAKE: cervical lymphadenopathy is one of the clinical criteria.' },
    ],
  },
  {
    topicKey: 'fake-kawasaki-disease',
    topicName: 'FAKE Kawasaki Disease',
    stem: 'FAKE Q18: A child meets the criteria for Kawasaki disease on day 6 of fever. Which treatment reduces the risk of coronary artery damage?',
    educationalObjective: 'FAKE objective: give IVIG plus aspirin for Kawasaki disease.',
    pageNumber: 50,
    choices: [
      { text: 'FAKE: Oral antibiotic alone', isCorrect: false, explanation: 'FAKE: Kawasaki disease is not a bacterial infection, so antibiotics do not help.' },
      { text: 'FAKE: Intravenous immunoglobulin plus aspirin', isCorrect: true, explanation: 'FAKE: IVIG with aspirin is the standard treatment and lowers coronary risk.' },
      { text: 'FAKE: Oral corticosteroid alone', isCorrect: false, explanation: 'FAKE: steroids alone are not first-line and are reserved for resistant disease.' },
      { text: 'FAKE: Antiviral therapy', isCorrect: false, explanation: 'FAKE: no antiviral is indicated; the cause is not established.' },
    ],
  },
  {
    topicKey: 'fake-type1-diabetes',
    topicName: 'FAKE Type 1 Diabetes',
    stem: 'FAKE Q19: A 10-year-old presents with weight loss, polyuria and deep sighing breathing. Capillary glucose is high and ketones are present. What is the diagnosis?',
    educationalObjective: 'FAKE objective: recognise diabetic ketoacidosis at presentation.',
    pageNumber: 52,
    choices: [
      { text: 'FAKE: Simple viral illness', isCorrect: false, explanation: 'FAKE: weight loss, hyperglycaemia and ketones point to diabetes, not a viral illness.' },
      { text: 'FAKE: Nephrogenic diabetes insipidus', isCorrect: false, explanation: 'FAKE: diabetes insipidus does not cause hyperglycaemia or ketosis.' },
      { text: 'FAKE: Hypercalcaemia', isCorrect: false, explanation: 'FAKE: calcium disturbance does not explain the glucose and ketone findings.' },
      { text: 'FAKE: Diabetic ketoacidosis', isCorrect: true, explanation: 'FAKE: hyperglycaemia, ketones and Kussmaul breathing define diabetic ketoacidosis.' },
    ],
  },
  {
    topicKey: 'fake-type1-diabetes',
    topicName: 'FAKE Type 1 Diabetes',
    stem: 'FAKE Q20: Which insulin regimen is usually started after a new diagnosis of type 1 diabetes in a child?',
    educationalObjective: 'FAKE objective: describe a basal-bolus insulin regimen.',
    pageNumber: 53,
    choices: [
      { text: 'FAKE: Basal insulin plus rapid-acting insulin with meals', isCorrect: true, explanation: 'FAKE: a basal-bolus regimen mimics physiological insulin release and is standard.' },
      { text: 'FAKE: Once-weekly long-acting insulin', isCorrect: false, explanation: 'FAKE: no weekly insulin is standard for childhood type 1 diabetes.' },
      { text: 'FAKE: Oral metformin alone', isCorrect: false, explanation: 'FAKE: metformin does not replace insulin in type 1 diabetes.' },
      { text: 'FAKE: Diet alone until puberty', isCorrect: false, explanation: 'FAKE: insulin is required from diagnosis; diet alone cannot prevent ketosis.' },
    ],
  },
  {
    topicKey: 'fake-congenital-heart',
    topicName: 'FAKE Congenital Heart Disease',
    stem: 'FAKE Q21: Which congenital heart lesion is the most common overall?',
    educationalObjective: 'FAKE objective: recall the most common congenital cardiac defect.',
    pageNumber: 55,
    choices: [
      { text: 'FAKE: Atrial septal defect', isCorrect: false, explanation: 'FAKE: atrial septal defect is common but less frequent than ventricular septal defect.' },
      { text: 'FAKE: Ventricular septal defect', isCorrect: true, explanation: 'FAKE: ventricular septal defect is the most common congenital heart lesion.' },
      { text: 'FAKE: Tetralogy of Fallot', isCorrect: false, explanation: 'FAKE: tetralogy of Fallot is the commonest cyanotic lesion, not the commonest overall.' },
      { text: 'FAKE: Coarctation of the aorta', isCorrect: false, explanation: 'FAKE: coarctation is less common than septal defects.' },
    ],
  },
  {
    topicKey: 'fake-congenital-heart',
    topicName: 'FAKE Congenital Heart Disease',
    stem: 'FAKE Q22: A newborn becomes deeply cyanosed on day 2 and does not improve with oxygen. Which treatment should be started while transfer is arranged?',
    educationalObjective: 'FAKE objective: use prostaglandin E1 in suspected duct-dependent lesions.',
    pageNumber: 56,
    choices: [
      { text: 'FAKE: High-flow oxygen alone', isCorrect: false, explanation: 'FAKE: duct-dependent cyanotic lesions do not respond to oxygen because the problem is mixing, not diffusion.' },
      { text: 'FAKE: Oral diuretic', isCorrect: false, explanation: 'FAKE: a diuretic does not keep the duct open.' },
      { text: 'FAKE: Prostaglandin E1 infusion', isCorrect: true, explanation: 'FAKE: prostaglandin E1 keeps the ductus arteriosus open in suspected duct-dependent lesions.' },
      { text: 'FAKE: Immediate discharge with follow-up', isCorrect: false, explanation: 'FAKE: a cyanosed newborn with suspected duct-dependent circulation needs urgent referral.' },
    ],
  },
  {
    topicKey: 'fake-iron-deficiency-anaemia',
    topicName: 'FAKE Iron Deficiency Anaemia',
    stem: 'FAKE Q23: A 2-year-old is pale and tired. Haemoglobin is low with a microcytic hypochromic picture. Which result supports iron deficiency?',
    educationalObjective: 'FAKE objective: interpret iron studies in microcytic anaemia.',
    pageNumber: 58,
    choices: [
      { text: 'FAKE: Low ferritin with low mean corpuscular volume', isCorrect: true, explanation: 'FAKE: a low ferritin with microcytosis is the classic picture of iron deficiency.' },
      { text: 'FAKE: High ferritin with high mean corpuscular volume', isCorrect: false, explanation: 'FAKE: that pattern suggests a different cause, such as B12 or folate deficiency.' },
      { text: 'FAKE: Normal ferritin with target cells', isCorrect: false, explanation: 'FAKE: target cells suggest haemoglobinopathy, not iron deficiency.' },
      { text: 'FAKE: Low reticulocytes with normal iron studies', isCorrect: false, explanation: 'FAKE: a pure production failure without iron changes is not iron deficiency.' },
    ],
  },
  {
    topicKey: 'fake-iron-deficiency-anaemia',
    topicName: 'FAKE Iron Deficiency Anaemia',
    stem: 'FAKE Q24: A toddler drinks more than a litre of cow milk daily and eats little solid food. Iron deficiency is confirmed. What is the key management step?',
    educationalObjective: 'FAKE objective: combine dietary change with oral iron therapy.',
    pageNumber: 59,
    choices: [
      { text: 'FAKE: Continue the same diet and repeat the blood test in a year', isCorrect: false, explanation: 'FAKE: the causative diet must change; waiting a year allows the deficiency to persist.' },
      { text: 'FAKE: Blood transfusion for every case', isCorrect: false, explanation: 'FAKE: transfusion is reserved for severe or symptomatic anaemia.' },
      { text: 'FAKE: Vitamin B12 injections', isCorrect: false, explanation: 'FAKE: the deficiency is iron, not B12.' },
      { text: 'FAKE: Reduce cow milk, add iron-rich foods and start oral iron', isCorrect: true, explanation: 'FAKE: cutting excess milk, improving diet and giving oral iron treats both the cause and the deficiency.' },
    ],
  },
  {
    topicKey: 'fake-child-development',
    topicName: 'FAKE Child Development',
    stem: 'FAKE Q25: At what age does a social smile usually appear in a healthy infant?',
    educationalObjective: 'FAKE objective: recall the typical age of the social smile.',
    pageNumber: 60,
    choices: [
      { text: 'FAKE: At birth', isCorrect: false, explanation: 'FAKE: smiling at birth is reflex-like, not a social response.' },
      { text: 'FAKE: Around 6 weeks', isCorrect: true, explanation: 'FAKE: a responsive social smile typically appears around 6 weeks.' },
      { text: 'FAKE: Around 9 months', isCorrect: false, explanation: 'FAKE: by 9 months social smiling is well established; 9 months is far too late as the first smile.' },
      { text: 'FAKE: Around 18 months', isCorrect: false, explanation: 'FAKE: 18 months is well past the expected emergence of reciprocal smiling.' },
    ],
  },
];

/** Fails loudly if the fixture drifts from the rules the exam flow relies on. */
function validateFixtures(): void {
  if (QUESTIONS.length !== 25) {
    throw new Error(`Fixture must hold 25 questions, found ${QUESTIONS.length}.`);
  }

  const perTopic = new Map<string, number>();
  for (const question of QUESTIONS) {
    perTopic.set(question.topicKey, (perTopic.get(question.topicKey) ?? 0) + 1);
    if (question.choices.length !== 4) {
      throw new Error(`${question.stem}: expected 4 choices.`);
    }
    if (question.choices.filter((choice) => choice.isCorrect).length !== 1) {
      throw new Error(`${question.stem}: expected exactly 1 correct choice.`);
    }
    if (question.pageNumber < 1 || question.pageNumber > DOCUMENT_PAGE_COUNT) {
      throw new Error(`${question.stem}: citation page out of range.`);
    }
  }

  if (perTopic.size < 13) {
    throw new Error(`Fixture needs at least 13 topics, found ${perTopic.size}.`);
  }
  for (const [key, count] of perTopic) {
    if (count > 2) throw new Error(`Topic ${key} has ${count} questions; the maximum is 2.`);
  }
}

function buildTopics(): { key: string; name: string }[] {
  const topics = new Map<string, string>();
  for (const question of QUESTIONS) {
    if (!topics.has(question.topicKey)) {
      topics.set(question.topicKey, question.topicName);
    }
  }
  return [...topics].map(([key, name]) => ({ key, name }));
}

type Mode = 'dry-run' | 'apply' | 'cleanup';

function readMode(): Mode {
  const apply = process.argv.includes('--apply');
  const cleanup = process.argv.includes('--cleanup');
  if (apply && cleanup) {
    throw new Error('Use either --apply or --cleanup, not both.');
  }
  if (cleanup) return 'cleanup';
  if (apply) return 'apply';
  return 'dry-run';
}

function printPlan(): void {
  console.log(
    `Plan: create 1 subject, 1 document, ${buildTopics().length} topics, ` +
      `${QUESTIONS.length} questions, ${QUESTIONS.length * 4} choices, ${QUESTIONS.length} citations.`,
  );
}

async function dryRun(prisma: PrismaClient): Promise<void> {
  const subject = await prisma.subject.findUnique({
    where: { name: SUBJECT_NAME },
    select: { id: true },
  });

  if (!subject) {
    console.log(`Subject ${SUBJECT_NAME}: not found.`);
    printPlan();
    console.log('Dry run: no changes made. Re-run with --apply to write.');
    return;
  }

  const [topics, questions, choices, citations, attempts] = await Promise.all([
    prisma.subjectTopic.count({ where: { subjectId: subject.id } }),
    prisma.mockQuestion.count({ where: { subjectId: subject.id } }),
    prisma.mockChoice.count({ where: { question: { subjectId: subject.id } } }),
    prisma.questionCitation.count({ where: { question: { subjectId: subject.id } } }),
    prisma.mockAttempt.count({ where: { subjectId: subject.id } }),
  ]);

  console.log(`Subject ${SUBJECT_NAME}: found (${subject.id}).`);
  console.log(
    `Existing rows: topics=${topics} questions=${questions} choices=${choices} citations=${citations} attempts=${attempts}.`,
  );
  printPlan();
  console.log('--apply would refuse while the subject exists. Use --cleanup first.');
  console.log('Dry run: no changes made.');
}

async function apply(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.subject.findUnique({
    where: { name: SUBJECT_NAME },
    select: { id: true },
  });
  if (existing) {
    throw new Error(
      `Refusing --apply: subject "${SUBJECT_NAME}" already exists (${existing.id}). Run --cleanup first.`,
    );
  }

  const topics = buildTopics();

  // Subject, document and topics are one unit; the questions come after.
  const created = await prisma.$transaction(
    async (tx) => {
      const subject = await tx.subject.create({
        data: {
          name: SUBJECT_NAME,
          instructions: 'FAKE fixture subject. Delete with --cleanup when no longer needed.',
          documents: {
            create: {
              title: DOCUMENT_TITLE,
              fileUrl: DOCUMENT_FILE_URL,
              fileSize: DOCUMENT_FILE_SIZE,
              pageCount: DOCUMENT_PAGE_COUNT,
              status: 'READY',
              // pdfObjectId stays NULL: no stored PDF, the citation only needs
              // the Document row to exist so isCitationEligible() passes.
              pdfObjectId: null,
            },
          },
          subjectTopics: { create: topics },
        },
        select: {
          id: true,
          documents: { select: { id: true } },
          subjectTopics: { select: { id: true, key: true } },
        },
      });

      const documentId = subject.documents[0]?.id;
      if (!documentId) throw new Error('Document row was not created.');

      return {
        subjectId: subject.id,
        documentId,
        topicIdByKey: new Map(
          subject.subjectTopics.map((topic) => [topic.key, topic.id]),
        ),
      };
    },
    TX_OPTIONS,
  );

  let choicesWritten = 0;
  let citationsWritten = 0;

  for (const question of QUESTIONS) {
    const topicId = created.topicIdByKey.get(question.topicKey);
    if (!topicId) {
      throw new Error(`Missing topic for ${question.topicKey}.`);
    }

    const stem = question.stem;
    const pageNumber = question.pageNumber;

    // One transaction per question: the R3 deferred trigger only passes when
    // the commit sees all 4 choices and exactly 1 correct one.
    await prisma.$transaction(
      async (tx) => {
        await tx.mockQuestion.create({
          data: {
            subjectId: created.subjectId,
            topicId,
            status: 'ACTIVE',
            stem,
            leadIn: question.leadIn ?? null,
            educationalObjective: question.educationalObjective,
            draftModel: 'fixture',
            promptVersion: 'fixture',
            validatorVersion: 'fixture',
            choices: {
              create: question.choices.map((choice, index) => ({
                position: index + 1,
                text: choice.text,
                isCorrect: choice.isCorrect,
                explanation: choice.explanation,
              })),
            },
            citations: {
              create: {
                // Real Document row of this fixture subject: keeps the
                // question eligible even though no PDF object exists.
                documentId: created.documentId,
                documentTitleSnapshot: DOCUMENT_TITLE,
                pageNumber,
                quote: `FAKE source text for ${stem.slice(0, 8)} (fixture citation, page ${pageNumber}).`,
              },
            },
          },
          select: { id: true },
        });
      },
      TX_OPTIONS,
    );

    choicesWritten += question.choices.length;
    citationsWritten += 1;
    console.log(`Wrote ${stem.slice(0, 8)}.`);
  }

  console.log('--- summary ---');
  console.log(`subjectId: ${created.subjectId}`);
  console.log(`documentId: ${created.documentId}`);
  console.log(`topics: ${topics.length}`);
  console.log(`questions: ${QUESTIONS.length}`);
  console.log(`choices: ${choicesWritten}`);
  console.log(`citations: ${citationsWritten}`);
}

async function cleanup(prisma: PrismaClient): Promise<void> {
  const subject = await prisma.subject.findUnique({
    where: { name: SUBJECT_NAME },
    select: { id: true, name: true },
  });

  if (!subject) {
    console.log(`Subject ${SUBJECT_NAME}: not found. Nothing to delete.`);
    return;
  }
  if (subject.name !== SUBJECT_NAME) {
    throw new Error(`Refusing cleanup: resolved subject name was "${subject.name}".`);
  }

  const [topics, questions, choices, citations, attempts, documents] =
    await Promise.all([
      prisma.subjectTopic.count({ where: { subjectId: subject.id } }),
      prisma.mockQuestion.count({ where: { subjectId: subject.id } }),
      prisma.mockChoice.count({ where: { question: { subjectId: subject.id } } }),
      prisma.questionCitation.count({ where: { question: { subjectId: subject.id } } }),
      prisma.mockAttempt.findMany({
        where: { subjectId: subject.id },
        select: { id: true, status: true, jobId: true, createdAt: true },
      }),
      prisma.document.count({ where: { subjectId: subject.id } }),
    ]);

  // Every attempt under this dedicated fixture subject is a test attempt. An
  // attempt tied to a GenerationJob cannot be described as fixture-only, so
  // cleanup stops instead of guessing.
  const undescribable = attempts.filter((attempt) => attempt.jobId !== null);
  if (undescribable.length > 0) {
    throw new Error(
      `Refusing cleanup: ${undescribable.length} attempt(s) reference a GenerationJob ` +
        `(${undescribable.map((attempt) => attempt.id).join(', ')}). Review them manually.`,
    );
  }

  console.log(`Subject ${SUBJECT_NAME}: ${subject.id}`);
  console.log(
    `Will delete: documents=${documents} topics=${topics} questions=${questions} ` +
      `choices=${choices} citations=${citations} attempts=${attempts.length}.`,
  );
  for (const attempt of attempts) {
    console.log(
      `  attempt ${attempt.id} status=${attempt.status} createdAt=${attempt.createdAt.toISOString()}`,
    );
  }
  console.log('Document row cascades from Subject (Document.subjectId ON DELETE CASCADE).');

  // Delete by the id resolved above, after the exact-name check. The Subject
  // cascade removes documents, topics, questions, choices, citations, attempts,
  // answers, results and reports that hang off it.
  await prisma.subject.delete({ where: { id: subject.id } });

  console.log(`Deleted subject ${SUBJECT_NAME} (${subject.id}) and its children.`);
}

async function main(): Promise<void> {
  const mode = readMode();
  validateFixtures();

  loadEnvFile(resolve(process.cwd(), '.env'));
  const prisma = new PrismaClient();

  try {
    if (mode === 'cleanup') {
      await cleanup(prisma);
      return;
    }
    if (mode === 'apply') {
      await apply(prisma);
      return;
    }
    await dryRun(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('SEED FAILED:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
