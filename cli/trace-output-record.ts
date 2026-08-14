import type { RecordWriter } from './export-stream';

export function writeUnavailableOutput(
  writer: RecordWriter,
  taskId: string,
  rawOutputRef: string
): void {
  writer.write({
    record_type: 'task_output_end',
    task_id: taskId,
    raw_output_ref: rawOutputRef,
    available: false,
    complete: false,
    byte_length: null,
    chunks: 0,
    sha256: null,
  });
}
