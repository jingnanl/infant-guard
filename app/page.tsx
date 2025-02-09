"use client";

import outputs from "@/amplify_outputs.json";
import { Authenticator } from '@aws-amplify/ui-react';
import { StorageImage } from '@aws-amplify/ui-react-storage';
import "@aws-amplify/ui-react/styles.css";
import { Box, Button, Paper, Stack, Typography } from "@mui/material";
import Grid from '@mui/material/Grid2';
import { Amplify } from "aws-amplify";
import { generateClient } from 'aws-amplify/data';
import { downloadData, uploadData } from 'aws-amplify/storage';
import { useEffect, useRef, useState } from "react";
import type { Schema } from '../amplify/data/resource';
import "./../app/app.css";

Amplify.configure(outputs);

const client = generateClient<Schema>();

// Function to convert blob to base64
const blobToBase64 = async (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = reader.result?.toString()?.replace(/^data:image\/\w+;base64,/, '');
      if (base64String) {
        resolve(base64String);
      } else {
        reject(new Error('Failed to convert blob to base64'));
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [monitorInterval, setMonitorInterval] = useState<NodeJS.Timeout | null>(null);
  const [latestAnalysis, setLatestAnalysis] = useState<Schema['BabyAnalysis']['type'] | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  // Initialize webcam
  useEffect(() => {
    async function setupCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: true,
          audio: true 
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch (err) {
        console.error('Error accessing webcam:', err);
      }
    }
    setupCamera();
  }, []);

  // TODO: uncomment
  // Start/stop monitoring when isRecording changes
  useEffect(() => {
    if (isRecording) {
      const interval = setInterval(captureAndAnalyze, 30000);
      setMonitorInterval(interval);
    } else {
      if (monitorInterval) {
        clearInterval(monitorInterval);
        setMonitorInterval(null);
      }
    }

    return () => {
      if (monitorInterval) {
        clearInterval(monitorInterval);
      }
    };
  },  [isRecording]);

  // TODO: delete
  // useEffect(() => {
  //   captureAndAnalyze();
  // }, [isRecording]);

  // Monitor baby status and respond if needed
  useEffect(() => {
    async function sendNotification() {
      if (latestAnalysis?.needsAttention) {
        try {
          // Get voice command from backend
          const response = await fetch('/api/generateVoiceCommand');
          const audioBlob = await response.blob();
          const audioUrl = URL.createObjectURL(audioBlob);
          const audio = new Audio(audioUrl);
          await audio.play();
        } catch (error) {
          console.error('Error playing voice command:', error);
        }
      }
    }
    sendNotification();
  }, [latestAnalysis]);

  // 当 latestAnalysis 发生变化且包含 audioKey 时，获取该音频文件的公开 URL
  useEffect(() => {
    async function fetchAudioUrl() {
      if (latestAnalysis?.audioKey) {
        try {
          const response = await downloadData({ path: latestAnalysis.audioKey }).result;
          const blob = await response.body.blob();
          const localUrl = URL.createObjectURL(blob);
          setAudioUrl(localUrl);
        } catch (err) {
          console.error('Error fetching audio url:', err);
        }
      }
    }
    fetchAudioUrl();
  }, [latestAnalysis]);

  // Function to capture and analyze image and audio
  const captureAndAnalyze = async () => {
    if (!videoRef.current) return;

    // =========1. Capture image via canvas===========
    const canvas = document.createElement('canvas');
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(videoRef.current, 0, 0);
    const imageData = canvas.toDataURL('image/jpeg');
    let imageBase64 = imageData.replace(/^data:image\/\w+;base64,/, '');

    // // For testing - properly wait for the test image
    // try {
    //   const testImage = await fetch('/samplePhotos/sleep.jpg');
    //   const blob = await testImage.blob();
    //   imageBase64 = await blobToBase64(blob);
    // } catch (error) {
    //   console.error('Error loading test image:', error);
    // }

    // =========2. Capture 5s audio snippet ===========
    // Get the current stream from video element (包括音频)
    const stream = videoRef.current.srcObject as MediaStream;
    const audioStream = new MediaStream(stream.getAudioTracks());
    // 设置 MediaRecorder 录制音频
    const mediaRecorder = new MediaRecorder(audioStream);
    const audioChunks: Blob[] = [];
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) audioChunks.push(event.data);
    };
    mediaRecorder.start();
    // 录制5秒钟
    await new Promise((resolve) => setTimeout(resolve, 5000));
    mediaRecorder.stop();
    await new Promise((resolve) => { mediaRecorder.onstop = resolve; });
    const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType });

    // =========3. 分析音频特征（使用 Web Audio API） ===========
    const audioContext = new AudioContext();
    const audioArrayBuffer = await audioBlob.arrayBuffer();
    const audioUploadBuffer = audioArrayBuffer.slice(0);
    const decodedAudio = await audioContext.decodeAudioData(audioArrayBuffer);
    const channelData = decodedAudio.getChannelData(0);

    // 辅助函数：计算RMS（均方根）音量
    function calculateRMS(data: Float32Array): number {
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        sum += data[i] * data[i];
      }
      return Math.sqrt(sum / data.length);
    }

    // 辅助函数：计算详细的频谱特征
    function calculateDetailedSpectralFeatures(data: Float32Array, sampleRate: number) {
      const fftSize = 2048;
      const analyzer = new AnalyserNode(audioContext, { fftSize });
      const tempBuffer = audioContext.createBuffer(1, data.length, sampleRate);
      tempBuffer.copyToChannel(data, 0);
      
      const source = audioContext.createBufferSource();
      source.buffer = tempBuffer;
      source.connect(analyzer);
      
      const frequencyData = new Float32Array(analyzer.frequencyBinCount);
      analyzer.getFloatFrequencyData(frequencyData);
      
      // 计算特定频段的能量
      const getBandEnergy = (startFreq: number, endFreq: number) => {
        const startBin = Math.floor(startFreq * fftSize / sampleRate);
        const endBin = Math.floor(endFreq * fftSize / sampleRate);
        let energy = 0;
        for (let i = startBin; i < endBin; i++) {
          energy += Math.pow(10, frequencyData[i] / 20);
        }
        return energy;
      };

      // 婴儿哭声的关键频段
      const cryBands = {
        fundamental: getBandEnergy(250, 600),    // 基频范围
        harmonic1: getBandEnergy(1000, 1600),    // 第一谐波
        harmonic2: getBandEnergy(2000, 3000),    // 第二谐波
        highFreq: getBandEnergy(3000, 4000)      // 高频成分
      };
      
      return {
        cryBands,
        totalEnergy: getBandEnergy(0, sampleRate/2),
        // 计算频段能量比例
        fundamentalRatio: cryBands.fundamental / getBandEnergy(0, sampleRate/2),
        harmonicRatio: (cryBands.harmonic1 + cryBands.harmonic2) / getBandEnergy(0, sampleRate/2)
      };
    }

    // 辅助函数：检测能量变化模式
    function analyzeEnergyPattern(data: Float32Array): {
      transientCount: number,
      rhythmicPattern: number,
      sustainedEnergy: number
    } {
      const frameSize = 512;
      const frames = Math.floor(data.length / frameSize);
      let transientCount = 0;
      let previousEnergy = 0;
      let energyPattern: number[] = [];
      let sustainedHighEnergyFrames = 0;
      
      for (let i = 0; i < frames; i++) {
        const frame = data.slice(i * frameSize, (i + 1) * frameSize);
        const energy = calculateRMS(frame);
        energyPattern.push(energy);
        
        // 检测能量突变
        if (i > 0) {
          const energyChange = energy / previousEnergy;
          if (energyChange > 1.5) {
            transientCount++;
          }
        }
        
        // 检测持续高能量
        if (energy > 0.1) { // 阈值可调整
          sustainedHighEnergyFrames++;
        }
        
        previousEnergy = energy;
      }
      
      // 计算节奏模式 - 寻找重复的能量变化
      let rhythmicCount = 0;
      for (let i = 2; i < energyPattern.length; i++) {
        const pattern1 = energyPattern[i] - energyPattern[i-1];
        const pattern2 = energyPattern[i-1] - energyPattern[i-2];
        if (Math.sign(pattern1) === Math.sign(pattern2)) {
          rhythmicCount++;
        }
      }
      
      return {
        transientCount,
        rhythmicPattern: rhythmicCount / frames,
        sustainedEnergy: sustainedHighEnergyFrames / frames
      };
    }

    // 主分析逻辑
    const rmsVolume = calculateRMS(channelData);
    const spectralFeatures = calculateDetailedSpectralFeatures(channelData, decodedAudio.sampleRate);
    const energyPattern = analyzeEnergyPattern(channelData);

    // 综合判断是否为哭声
    const isCrying = (
      // 1. 基频能量比例在预期范围内
      spectralFeatures.fundamentalRatio > 0.2 &&
      // 2. 谐波能量比例符合特征
      spectralFeatures.harmonicRatio > 0.15 &&
      // 3. 声音足够响亮
      rmsVolume > 0.08 &&
      // 4. 持续时间特征
      energyPattern.sustainedEnergy > 0.3 &&
      // 5. 节奏特征
      energyPattern.rhythmicPattern > 0.4
    );

    const audioFeatures = {
      rmsVolume,
      spectralFeatures,
      energyPattern,
      duration: decodedAudio.duration,
      isCrying
    };

    console.log("Enhanced audioFeatures:", audioFeatures);

    // =========4. 上传图像和音频至 S3 ===========
    const timestamp = new Date().toISOString();
    const imageBuffer = Buffer.from(imageBase64, 'base64');
    const imageUploadResult = await uploadData({
      data: imageBuffer,
      path: `captures/${timestamp}.jpg`,
    }).result;
    const imageKey = imageUploadResult.path;
    
    const audioBufferForUpload = Buffer.from(audioUploadBuffer);
    const audioExtension = mediaRecorder.mimeType ? mediaRecorder.mimeType.split('/')[1] : 'audio';
    const audioUploadResult = await uploadData({
      data: audioBufferForUpload,
      path: `captures/${timestamp}.${audioExtension}`,
    }).result;
    const audioKey = audioUploadResult.path;

    // =========5. 调用 API，传递图像、音频以及音频分析结果 ===========
    try {
      const response = await fetch('/api/analyzeBabyStatus', {
        method: 'POST',
        body: JSON.stringify({
          imageKey,
          imageBuffer: imageBase64,
          audioKey,
          audioFeatures
        })
      });
      const analysisResult = await response.json();

      // 3. Store analysis results
      const savedAnalysis = await client.models.BabyAnalysis.create({
        imageKey,
        audioKey,
        analysis: analysisResult.analysis,
        faceAnalysis: JSON.stringify(analysisResult.faceAnalysis),
        audioAnalysis: JSON.stringify(analysisResult.audioAnalysis),
        needsAttention: analysisResult.needsAttention,
        createdAt: timestamp
      });

      setLatestAnalysis(savedAnalysis.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  return (
    <Authenticator>
      {({ signOut, user }) => (
        <Box sx={{ p: 1, width: '90%' }}>
          <Typography variant="h3" sx={{ textAlign: 'center', mb: 2 }}>
              Baby Monitor
          </Typography>
          <Grid container spacing={2}>
            <Grid size={8}>
              <Paper elevation={3} sx={{ p: 2 }}>
                <Box sx={{ position: 'relative', width: '100%', height: 'auto' }}>
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    style={{ width: '100%', height: 'auto' }}
                  />
                </Box>
                <Box sx={{ display: 'flex', justifyContent: 'center' }}>
                  <Button 
                    variant="contained" 
                    onClick={() => setIsRecording(!isRecording)}
                    sx={{ mt: 2 }}
                  >
                    {isRecording ? 'Stop Monitoring' : 'Start Monitoring'}
                  </Button>
                </Box>
              </Paper>
            </Grid>
            <Grid size={4}>
              <Paper elevation={3} sx={{ p: 2 }}>
                <Typography variant="h5" gutterBottom>
                  Analysis Results
                </Typography>
                {latestAnalysis ? (
                  <Box>
                    <Stack spacing={2}>
                      <Typography>
                        Status: {latestAnalysis.analysis?.match(/<STATUS>(.*?)<\/STATUS>/)?.[1] || 'Unknown'}
                      </Typography>
                      <Typography>
                        Last Updated: {new Date(latestAnalysis.createdAt).toLocaleString()}
                      </Typography>
                      <Typography>
                        Analysis: {latestAnalysis.analysis?.match(/<ANALYSIS>([\s\S]*?)<\/ANALYSIS>/)?.[1] || 'No analysis available'}
                      </Typography>
                      <Box sx={{ mt: 2 }}>
                        <StorageImage alt="Baby snapshot" path={latestAnalysis.imageKey || ''} />
                      </Box>
                      {audioUrl && (
                        <Box sx={{ mt: 2 }}>
                          <audio controls style={{ width: '100%' }}>
                            <source src={audioUrl} type="audio/mpeg" />
                            Your browser does not support the audio element.
                          </audio>
                        </Box>
                      )}
                    </Stack>
                  </Box>
                ) : (
                  <Typography>
                    No analysis yet
                  </Typography>
                )}
              </Paper>
            </Grid>
          </Grid>
        </Box>)}
    </Authenticator>
  );
}
