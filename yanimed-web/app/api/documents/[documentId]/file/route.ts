import { NextRequest, NextResponse } from "next/server";
import { API_BASE_URL } from "@/lib/api";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ documentId: string }> }
) {
  const { documentId } = await params;
  
  try {
    const response = await fetch(`${API_BASE_URL}/documents/${encodeURIComponent(documentId)}/file`);
    
    if (!response.ok) {
      if (response.status === 404) {
        return new NextResponse("Document not found", { status: 404 });
      }
      return new NextResponse("Failed to load document", { status: response.status });
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "application/pdf";
    
    return new NextResponse(arrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": arrayBuffer.byteLength.toString(),
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return new NextResponse("Could not reach the API", { status: 502 });
  }
}