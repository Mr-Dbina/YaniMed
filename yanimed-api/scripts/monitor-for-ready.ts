import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function monitorForReady(subjectName: string, maxWaitSeconds = 1800) {
  const startTime = Date.now();
  const endTime = startTime + (maxWaitSeconds * 1000);
  
  console.log(`=== Monitoring for subject "${subjectName}" ===`);
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log(`Max wait time: ${maxWaitSeconds}s (${Math.floor(maxWaitSeconds / 60)} minutes)\n`);
  
  let subjectFound = false;
  let lastStatus = '';
  let checkCount = 0;
  
  while (Date.now() < endTime) {
    try {
      checkCount++;
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      
      const subject = await prisma.subject.findFirst({
        where: { name: subjectName, status: 'ACTIVE' },
        include: {
          documents: {
            select: {
              id: true,
              title: true,
              status: true,
              pageCount: true,
              processedPages: true,
              embeddedChunks: true,
              errorMessage: true,
              createdAt: true
            }
          }
        }
      });
      
      if (!subject) {
        if (!subjectFound) {
          const status = `⏳ Waiting for subject to be created... (${elapsed}s, check #${checkCount})`;
          if (checkCount === 1 || checkCount % 30 === 0) {
            console.log(status);
          }
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      
      if (!subjectFound) {
        console.log(`\n✅ Subject "${subjectName}" found! (${elapsed}s elapsed)`);
        subjectFound = true;
      }
      
      if (subject.documents.length === 0) {
        const status = `⏳ Subject exists but no documents yet (${elapsed}s)`;
        if (status !== lastStatus) {
          console.log(status);
          lastStatus = status;
        }
      } else {
        const readyDocs = subject.documents.filter(d => d.status === 'READY');
        const processingDocs = subject.documents.filter(d => d.status === 'PROCESSING');
        const queuedDocs = subject.documents.filter(d => d.status === 'QUEUED');
        const failedDocs = subject.documents.filter(d => d.status === 'FAILED');
        
        const status = `📄 Documents: ${subject.documents.length} | ` +
          `✅ ${readyDocs.length} READY, ⚙️ ${processingDocs.length} PROCESSING, ` +
          `⏸️ ${queuedDocs.length} QUEUED, ❌ ${failedDocs.length} FAILED | ` +
          `${elapsed}s`;
        
        if (status !== lastStatus) {
          console.log(status);
          lastStatus = status;
          
          // Show detailed progress for processing documents
          processingDocs.forEach(doc => {
            console.log(`  ⚙️  ${doc.title}: pages ${doc.processedPages}/${doc.pageCount || '?'}, chunks ${doc.embeddedChunks}`);
          });
          
          queuedDocs.forEach(doc => {
            console.log(`  ⏸️  ${doc.title}: waiting to start`);
          });
          
          failedDocs.forEach(doc => {
            console.log(`  ❌ ${doc.title}: ${doc.errorMessage || 'unknown error'}`);
          });
        }
        
        if (readyDocs.length > 0) {
          console.log(`\n🎉 SUCCESS! ${readyDocs.length} document(s) are READY after ${elapsed}s\n`);
          readyDocs.forEach(doc => {
            console.log(`  ✅ ${doc.title}`);
            console.log(`     Pages: ${doc.pageCount}`);
            console.log(`     Chunks: ${doc.embeddedChunks}`);
            console.log(`     ID: ${doc.id}`);
          });
          console.log();
          await prisma.$disconnect();
          process.exit(0);
        }
      }
      
      // Wait 2 seconds before next check
      await new Promise(resolve => setTimeout(resolve, 2000));
      
    } catch (error) {
      console.error('\n❌ Error checking status:', error);
      await prisma.$disconnect();
      process.exit(1);
    }
  }
  
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  console.log(`\n⏱️ Timeout reached after ${elapsed}s. Documents not ready yet.`);
  console.log('Run this script again when you\'re ready to continue.');
  await prisma.$disconnect();
  process.exit(1);
}

const subjectName = process.argv[2] || 'ZZ-web3b-test1';
const maxWait = parseInt(process.argv[3] || '1800', 10);

monitorForReady(subjectName, maxWait);
