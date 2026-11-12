import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function listAllSubjects() {
  try {
    const subjects = await prisma.subject.findMany({
      select: {
        id: true,
        name: true,
        status: true,
        createdAt: true,
        _count: {
          select: {
            documents: true
          }
        },
        documents: {
          select: {
            title: true,
            status: true,
            pageCount: true,
            embeddedChunks: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    
    console.log('=== All Subjects in Database ===\n');
    
    if (subjects.length === 0) {
      console.log('❌ No subjects found in database.\n');
      console.log('The frontend shows subjects, but they have not been committed to the database yet.');
      console.log('This may indicate:');
      console.log('  1. Initial upload transactions are still pending');
      console.log('  2. Upload process failed before database commit');
      console.log('  3. Frontend is showing cached/pending state\n');
      return;
    }
    
    subjects.forEach((subject, index) => {
      console.log(`${index + 1}. ${subject.name}`);
      console.log(`   ID: ${subject.id}`);
      console.log(`   Status: ${subject.status}`);
      console.log(`   Created: ${subject.createdAt.toISOString()}`);
      console.log(`   Documents: ${subject._count.documents}`);
      
      if (subject.documents.length > 0) {
        subject.documents.forEach(doc => {
          console.log(`     - ${doc.title} (${doc.status}, pages: ${doc.pageCount}, chunks: ${doc.embeddedChunks})`);
        });
      }
      console.log();
    });
    
    const readySubjects = subjects.filter(s => 
      s.documents.some(d => d.status === 'READY')
    );
    
    if (readySubjects.length > 0) {
      console.log('✅ Subjects with READY documents:');
      readySubjects.forEach(s => console.log(`   - ${s.name}`));
    } else {
      console.log('⏳ No subjects with READY documents yet.');
    }
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

listAllSubjects();
