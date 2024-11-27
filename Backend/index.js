import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { OpenAI } from 'openai';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobePath from 'ffprobe-static';
import path from 'path';
import fs from 'fs';
import say from 'say';
import { fileURLToPath } from 'url';

// Initialize dotenv
dotenv.config();

// Constants
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outputDir = path.join(__dirname, 'output');

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Set ffmpeg and ffprobe paths
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath.path);
console.log('ffmpeg path:', ffmpegPath);
console.log('ffprobe path:', ffprobePath.path);

// Ensure the output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
}

// Initialize Express
const app = express();
app.use(cors());
app.use(express.json());

// Function to retry OpenAI API requests in case of rate limit errors
async function callOpenAIWithRetry(prompt, retries = 5, delay = 2000) {
  try {
    // Make the API call
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    if (error.response?.status === 429 && retries > 0) {
      console.log(`Rate limit exceeded, retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return callOpenAIWithRetry(prompt, retries - 1, delay * 2);  // Exponentially increase delay
    } else {
      throw error;  // Re-throw if it's not a rate limit error or retries are exhausted
    }
  }
}

// Route to handle prompt submission
app.post('/api/generate', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required.' });
  }

  try {
    // Generate a response from OpenAI using the retry logic
    const textResponse = await callOpenAIWithRetry(prompt);
    console.log('Generated Text:', textResponse);

    // Generate audio from text
    const audioPath = await generateAudioFromText(textResponse);

    // Generate video from text and audio with dynamic text
    const videoPath = await generateVideoFromTextAndAudio(textResponse, audioPath);

    // Send the video file as a stream
    res.sendFile(videoPath, (err) => {
      if (err) {
        console.error('Error sending video file:', err);
      }

      // Clean up temporary files
      fs.unlink(videoPath, (err) => {
        if (err) {
          console.error('Error deleting video file:', err);
        }
      });
      fs.unlink(audioPath, (err) => {
        if (err) {
          console.error('Error deleting audio file:', err);
        }
      });
    });
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    res.status(500).json({ error: 'An error occurred while processing your request.' });
  }
});

// Function to generate audio from text
async function generateAudioFromText(text) {
  return new Promise((resolve, reject) => {
    const audioPath = path.join(outputDir, `audio_${Date.now()}.wav`);

    // Use 'say' library for TTS
    say.export(text, null, 1.0, audioPath, (err) => {
      if (err) {
        console.error('Error generating audio:', err);
        reject(err);
      } else {
        console.log('Audio saved to:', audioPath);
        resolve(audioPath);
      }
    });
  });
}

// Function to split text into smaller chunks (e.g., words or phrases)
function splitText(text, chunkSize = 5) {
  const words = text.split(/\s+/);
  const chunks = [];

  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize).join(' '));
  }

  return chunks;
}

// Function to escape text for FFmpeg
function escapeFFmpegText(text) {
  return text
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

// Function to generate a video from text and audio with dynamic text
async function generateVideoFromTextAndAudio(text, audioPath) {
  return new Promise((resolve, reject) => {
    const videoPath = path.join(outputDir, `output_${Date.now()}.mp4`);
    const textChunks = splitText(text, 5);
    const escapedChunks = textChunks.map(chunk => escapeFFmpegText(chunk.trim()));

    const fontPath = path.join(__dirname, 'fonts', 'Arial.ttf').replace(/\\/g, '/');
    if (!fs.existsSync(fontPath)) {
      console.error('Font file does not exist:', fontPath);
      reject(new Error('Font file not found.'));
      return;
    }

    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) {
        console.error('Error getting audio metadata:', err);
        reject(err);
        return;
      }

      const duration = metadata.format.duration;
      const totalWords = text.split(/\s+/).length;
      const timePerWord = duration / totalWords;
      const timePerChunk = timePerWord * 5;

      const timings = [];
      let currentTime = 0;

      escapedChunks.forEach(chunk => {
        timings.push({
          text: chunk,
          start: currentTime,
          end: currentTime + timePerChunk,
        });
        currentTime += timePerChunk;
      });

      const filterComplex = timings.map(segment => {
        const fadeDuration = 0.5;
        return `drawtext=fontfile='${fontPath}':text='${segment.text}':fontsize=40:fontcolor=white:` +
               `x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.5:boxborderw=5:` +
               `enable='between(t,${segment.start},${segment.end})':` +
               `alpha='if(between(t,${segment.start},${segment.start + fadeDuration}),(t-${segment.start})/${fadeDuration},` +
               `if(between(t,${segment.end - fadeDuration},${segment.end}),(${segment.end}-t)/${fadeDuration},1))'`;
      }).join(',');

      ffmpeg()
        .input('color=c=black:s=1280x720:d=' + duration)
        .inputOptions(['-f lavfi'])
        .input(audioPath)
        .complexFilter(filterComplex)
        .outputOptions(['-c:v libx264', '-pix_fmt yuv420p', `-t ${duration}`])
        .audioCodec('aac')
        .on('start', commandLine => console.log('FFmpeg command:', commandLine))
        .on('end', () => resolve(videoPath))
        .on('error', (err, stdout, stderr) => {
          console.error('FFmpeg Error:', err);
          reject(err);
        })
        .save(videoPath);
    });
  });
}

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend server started on port ${PORT}`);
});

