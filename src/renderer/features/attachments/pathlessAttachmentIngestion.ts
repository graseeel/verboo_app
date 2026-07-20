import type { AttachmentMeta } from '../../../shared/types'

export async function inspectPathlessFiles(
  files: File[],
  inspectImage: (file: File) => Promise<AttachmentMeta[]>,
  uploadFile: (file: File) => Promise<AttachmentMeta>,
): Promise<AttachmentMeta[]> {
  const attachments: AttachmentMeta[] = []
  for (const file of files) {
    const inspected = file.type.startsWith('image/')
      ? await inspectImage(file)
      : [await uploadFile(file)]
    attachments.push(...inspected)
  }
  return attachments
}
