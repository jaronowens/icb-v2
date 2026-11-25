/* The progress of a background job, as /status reports it. Shared by the perceptual hash and thumbnail jobs. */
type JobState = 'idle' | 'running' | 'failed';
type JobStatus = { state: JobState, done: number, total: number };
const IDLE_STATUS: JobStatus = { state: 'idle', done: 0, total: 0 };

export { IDLE_STATUS, JobState, JobStatus };
