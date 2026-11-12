import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function waitForReady(subjectName: string, maxWaitSeconds = 600) {
  const startTime = Date.now();
  const endTime = startTime + (maxWaitSeconds * 1000);
  
  console.log(`Waiting for subject "${subjectName}" to have READY documents...`);
  console.log(`Max wait time: ${maxWaitSeconds}s\n`);
  
  let lastStatus = '';
  
  while (Date.now() < endTime) {
    try {
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
              errorMessage: true
            }
          }
        }
      });
      
      if (!subject) {
        console.log(`❌ Subject "${subjectName}" not found in database.`);
        await prisma.$disconnect();
        process.exit(1);
      }
      
      if (subject.documents.length === 0) {
        const status = `No documents yet (${Math.floor((Date.now() - startTime) / 1000)}s elapsed)`;
        if (status !== lastStatus) {
          console.log(status);
          lastStatus = status;
        }
      } else {
        const readyDocs = subject.documents.filter(d => d.status === 'READY');
        const processingDocs = subject.documents.filter(d => d.status === 'PROCESSING');
        const queuedDocs = subject.documents.filter(d => d.status === 'QUEUED');
        const failedDocs = subject.documents.filter(d => d.status === 'FAILED');
        
        const status = `Documents: ${subject.documents.length} total | ` +
          `${readyDocs.length} READY, ${processingDocs.length} PROCESSING, ` +
          `${queuedDocs.length} QUEUED, ${failedDocs.length} FAILED | ` +
          `(${Math.floor((Date.now() - startTime) / 1000)}s elapsed)`;
        
        if (status !== lastStatus) {
          console.log(status);
          
          // Show detailed progress for processing documents
          if (processingDocs.length > 0) {
            processingDocs.forEach(doc => {
              console.log(`  Processing: ${doc.title} - pages ${doc.processedPages}/${doc.pageCount}, chunks ${doc.embeddedChunks}`);
            });
          }
          
          if (failedDocs.length > 0) {
            failedDocs.forEach(doc => {
              console.log(`  ❌ Failed: ${doc.title} - ${doc.errorMessage}`);
            });
          }
          
          lastStatus = status;
        }
        
        if (readyDocs.length > 0) {
          console.log(`\n✅ SUCCESS: ${readyDocs.length} document(s) are READY!\n`);
          readyDocs.forEach(doc => {
            console.log(`  - ${doc.title} (${doc.pageCount} pages, ${doc.embeddedChunks} chunks)`);
          });
          await prisma.$disconnect();
          process.exit(0);
        }
      }
      
      // Wait 2 seconds before next check
      await new Promise(resolve => setTimeout(resolve, 2000));
      
    } catch (error) {
      console.error('Error checking status:', error);
      await prisma.$disconnect();
      process.exit(1);
    }
  }
  
  console.log(`\n⏱️  Timeout reached after ${maxWaitSeconds}s. Documents not ready yet.`);
  await prisma.$disconnect();
  process.exit(1);
}

const subjectName = process.argv[2] || 'ZZ-web3b-test1';
const maxWait = parseInt(process.argv[3] || '600', 10);

waitForReady(subjectName, maxWait);
